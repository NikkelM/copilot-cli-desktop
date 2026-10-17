use std::time::Duration;

use reqwest::Url;
use semver::Version;
use serde::Deserialize;

const RELEASES: &str = "https://api.github.com/repos/NikkelM/copilot-cli-desktop/releases";

#[derive(Deserialize)]
struct Asset {
    name: String,
    browser_download_url: Url,
}

#[derive(Deserialize)]
struct GitHubRelease {
    tag_name: String,
    draft: bool,
    prerelease: bool,
    body: Option<String>,
    assets: Vec<Asset>,
}

#[derive(Clone, Debug)]
pub struct PublishedRelease {
    pub version: Version,
    pub manifest: Url,
    pub notes: Option<String>,
}

#[derive(Default)]
pub struct Releases {
    pub stable: Option<PublishedRelease>,
    pub preview: Option<PublishedRelease>,
    pub current: Option<PublishedRelease>,
}

impl Releases {
    fn include(&mut self, release: GitHubRelease, current: &Version) -> Result<(), String> {
        if release.draft {
            return Ok(());
        }
        let Some(asset) = release
            .assets
            .into_iter()
            .find(|asset| asset.name == "latest.json")
        else {
            return Ok(());
        };
        let version = Version::parse(
            release
                .tag_name
                .strip_prefix('v')
                .unwrap_or(&release.tag_name),
        )
        .map_err(|error| format!("Invalid app release tag {}: {error}", release.tag_name))?;
        if release.prerelease == version.pre.is_empty() {
            return Err(format!(
                "The prerelease flag does not match release {}",
                release.tag_name
            ));
        }
        if !version.build.is_empty() {
            return Err("App update versions must not rely on build metadata".into());
        }
        let expected = format!(
            "https://github.com/NikkelM/copilot-cli-desktop/releases/download/{}/latest.json",
            release.tag_name
        );
        if asset.browser_download_url.as_str() != expected {
            return Err(format!(
                "Unexpected update manifest URL for {}",
                release.tag_name
            ));
        }
        let published = PublishedRelease {
            version: version.clone(),
            manifest: asset.browser_download_url,
            notes: release.body.filter(|notes| !notes.trim().is_empty()),
        };
        if version == *current {
            self.current = Some(published.clone());
        }
        let destination = if release.prerelease {
            &mut self.preview
        } else {
            &mut self.stable
        };
        if destination
            .as_ref()
            .is_none_or(|previous| version > previous.version)
        {
            *destination = Some(published);
        }
        Ok(())
    }

    pub fn newest(&self, include_prereleases: bool) -> Option<&PublishedRelease> {
        if !include_prereleases {
            return self.stable.as_ref();
        }
        [self.stable.as_ref(), self.preview.as_ref()]
            .into_iter()
            .flatten()
            .max_by(|left, right| left.version.cmp(&right.version))
    }
}

pub fn eligible(
    current: &Version,
    candidate: &Version,
    include_prereleases: bool,
    rollback: bool,
) -> bool {
    if rollback {
        !current.pre.is_empty() && candidate.pre.is_empty() && candidate != current
    } else {
        candidate > current && (include_prereleases || candidate.pre.is_empty())
    }
}

fn release_client() -> Result<reqwest::Client, String> {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let installed = rustls::crypto::ring::default_provider().install_default();
        if installed.is_err() && rustls::crypto::CryptoProvider::get_default().is_none() {
            return Err("Could not configure the release-discovery TLS provider".into());
        }
    }
    reqwest::Client::builder()
        .user_agent(concat!("copilot-cli-desktop/", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| format!("Could not initialise release discovery: {error}"))
}

pub async fn published_releases(current: &Version) -> Result<Releases, String> {
    let client = release_client()?;
    let mut found = Releases::default();
    for page in 1..=20 {
        let releases = client
            .get(format!("{RELEASES}?per_page=100&page={page}"))
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
            .map_err(|error| format!("Could not discover app releases: {error}"))?
            .json::<Vec<GitHubRelease>>()
            .await
            .map_err(|error| format!("Could not read app release metadata: {error}"))?;
        let last_page = releases.len() < 100;
        for release in releases {
            found.include(release, current)?;
        }
        if last_page {
            return Ok(found);
        }
    }
    Err("Release discovery exceeded its page limit; check the repository's release history".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_http_client_initialises_tls_without_a_prior_updater_check() {
        let _client = release_client()
            .expect("startup release discovery must initialise its own TLS provider");
    }

    #[test]
    fn release_http_client_can_be_constructed_more_than_once() {
        let _first = release_client().unwrap();
        let _second = release_client().unwrap();
    }

    fn release(version: &str, prerelease: bool) -> GitHubRelease {
        GitHubRelease {
            tag_name: format!("v{version}"),
            draft: false,
            prerelease,
            body: Some(format!("Notes for {version}")),
            assets: vec![Asset {
                name: "latest.json".into(),
                browser_download_url: format!(
                    "https://github.com/NikkelM/copilot-cli-desktop/releases/download/v{version}/latest.json"
                ).parse().unwrap(),
            }],
        }
    }

    #[test]
    fn prereleases_are_opt_in_and_numerically_ordered() {
        let mut found = Releases::default();
        let current = Version::parse("1.0.0").unwrap();
        found.include(release("1.0.0", false), &current).unwrap();
        found
            .include(release("1.1.0-beta.10", true), &current)
            .unwrap();
        found
            .include(release("1.1.0-beta.2", true), &current)
            .unwrap();
        assert_eq!(found.newest(false).unwrap().version.to_string(), "1.0.0");
        assert_eq!(
            found.newest(true).unwrap().version.to_string(),
            "1.1.0-beta.10"
        );
        found.include(release("1.1.0", false), &current).unwrap();
        assert_eq!(found.newest(true).unwrap().version.to_string(), "1.1.0");
        assert_eq!(
            found.current.as_ref().unwrap().notes.as_deref(),
            Some("Notes for 1.0.0")
        );
    }

    #[test]
    fn drafts_and_releases_without_updater_assets_are_not_offered() {
        let mut found = Releases::default();
        let current = Version::parse("1.0.0").unwrap();
        let mut draft = release("1.0.0", false);
        draft.draft = true;
        found.include(draft, &current).unwrap();
        let mut unsigned = release("1.1.0", false);
        unsigned.assets.clear();
        found.include(unsigned, &current).unwrap();
        assert!(found.newest(true).is_none());
        assert!(found.current.is_none());
    }

    #[test]
    fn current_release_requires_an_exact_valid_updater_release() {
        let current = Version::parse("1.1.0-beta.2").unwrap();
        let mut found = Releases::default();
        found
            .include(release("1.1.0-beta.1", true), &current)
            .unwrap();
        found.include(release("1.1.0", false), &current).unwrap();
        assert!(found.current.is_none());

        let mut exact = release("1.1.0-beta.2", true);
        exact.body = Some("  ".into());
        found.include(exact, &current).unwrap();
        let release = found.current.unwrap();
        assert_eq!(release.version, current);
        assert_eq!(release.notes, None);
    }

    #[test]
    fn channel_flags_and_manifest_origins_are_validated() {
        let mut found = Releases::default();
        let current = Version::parse("1.0.0").unwrap();
        assert!(found
            .include(release("1.0.0-beta.1", false), &current)
            .is_err());
        assert!(found.include(release("1.0.0", true), &current).is_err());
        let mut unexpected = release("1.0.0", false);
        unexpected.assets[0].browser_download_url =
            "https://example.invalid/latest.json".parse().unwrap();
        assert!(found.include(unexpected, &current).is_err());
    }

    #[test]
    fn rollback_is_explicit_and_only_returns_a_prerelease_to_a_stable_version() {
        let current = Version::parse("1.1.0-beta.2").unwrap();
        let stable = Version::parse("1.0.0").unwrap();
        assert!(!eligible(&current, &stable, false, false));
        assert!(eligible(&current, &stable, false, true));
        assert!(!eligible(
            &stable,
            &Version::parse("0.9.0").unwrap(),
            false,
            true
        ));
        assert!(!eligible(
            &current,
            &Version::parse("1.1.0-beta.1").unwrap(),
            true,
            true
        ));
        assert!(eligible(&stable, &current, true, false));
        assert!(!eligible(&stable, &current, false, false));
    }
}
