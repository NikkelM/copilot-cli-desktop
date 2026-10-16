use std::fs::{create_dir_all, read, read_to_string, remove_file};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::update_releases::{eligible, published_releases};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_updater::{Update, Updater, UpdaterExt};

const EVENT: &str = "app-update";

#[derive(Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Action {
    #[default]
    Idle,
    Checking,
    Downloading,
    Installing,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Release {
    pub version: String,
    pub notes: Option<String>,
    pub prerelease: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub revision: u64,
    pub current_version: String,
    pub action: Action,
    pub available: Option<Release>,
    pub ready: bool,
    pub downloaded: u64,
    pub total: Option<u64>,
    pub checked_at: Option<String>,
    pub error: Option<String>,
    pub install_supported: bool,
    pub current_prerelease: bool,
    pub include_prereleases: bool,
    pub stable_version: Option<String>,
    pub rollback: bool,
}

struct Inner {
    status: Status,
    offer: Option<Update>,
}

impl Inner {
    fn clear_offer(&mut self, cache: Option<&Cache>) -> Result<(), String> {
        if let Some(cache) = cache {
            cache.discard()?;
        }
        self.status.available = None;
        self.status.ready = false;
        self.status.downloaded = 0;
        self.status.total = None;
        self.offer = None;
        Ok(())
    }

    fn replace_offer(
        &mut self,
        update: Option<Update>,
        cache: Option<&Cache>,
    ) -> Result<(), String> {
        let ready = update.as_ref().is_some_and(|update| {
            self.status.ready
                && self.offer.as_ref().is_some_and(|previous| {
                    previous.version == update.version && previous.signature == update.signature
                })
        });
        if !ready {
            self.clear_offer(cache)?;
        }
        self.status.available = update.as_ref().map(release);
        self.status.ready = ready;
        self.status.checked_at = Some(chrono::Utc::now().to_rfc3339());
        self.status.revision += 1;
        self.offer = update;
        Ok(())
    }
}

#[derive(Clone)]
pub struct AppUpdates {
    inner: Arc<Mutex<Inner>>,
    cache: Option<Cache>,
}

#[derive(Clone)]
struct Cache {
    directory: PathBuf,
}

#[derive(Deserialize, Serialize)]
struct CachedRelease {
    version: String,
    raw: Value,
    #[serde(default)]
    rollback: bool,
}

fn validate_transport(update: &Update) -> Result<(), String> {
    if update.download_url.scheme() != "https" {
        return Err("The app update download must use HTTPS".into());
    }
    Ok(())
}

impl Cache {
    fn restore_for<R: tauri::Runtime>(
        &self,
        app: &AppHandle<R>,
        include_prereleases: bool,
    ) -> Result<Option<(Update, Vec<u8>, bool)>, String> {
        let rollback = self.metadata()?.is_some_and(|metadata| metadata.rollback);
        if rollback && include_prereleases {
            self.discard()?;
            return Ok(None);
        }
        let updater = configured_updater(app, include_prereleases, rollback, None)?;
        self.restore(&updater)
            .map(|restored| restored.map(|(update, bytes)| (update, bytes, rollback)))
    }

    fn metadata(&self) -> Result<Option<CachedRelease>, String> {
        let path = self.directory.join("pending.json");
        match read_to_string(&path) {
            Ok(text) => serde_json::from_str(&text)
                .map(Some)
                .map_err(|error| format!("Could not read cached update metadata: {error}")),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(format!("Could not read {}: {error}", path.display())),
        }
    }

    fn package(&self, version: &str) -> Result<PathBuf, String> {
        if version.is_empty()
            || version.len() > 128
            || !version
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b".-_".contains(&byte))
        {
            return Err("Invalid cached update version".into());
        }
        Ok(self.directory.join(format!("update-{version}.bin")))
    }

    fn discard(&self) -> Result<(), String> {
        let metadata = self.metadata()?;
        self.discard_pointer()?;
        if let Some(metadata) = metadata {
            self.remove_package(&metadata.version)?;
        }
        Ok(())
    }

    fn discard_pointer(&self) -> Result<(), String> {
        match remove_file(self.directory.join("pending.json")) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("Could not remove cached update metadata: {error}")),
        }
    }

    fn remove_package(&self, version: &str) -> Result<(), String> {
        let path = self.package(version)?;
        match remove_file(&path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("Could not remove {}: {error}", path.display())),
        }
    }

    fn restore(&self, updater: &Updater) -> Result<Option<(Update, Vec<u8>)>, String> {
        let Some(metadata) = self.metadata()? else {
            return Ok(None);
        };
        let restored = updater
            .restore_update(metadata.raw)
            .map_err(|error| format!("Could not restore the cached update: {error}"))?;
        let Some(update) = restored else {
            self.discard()?;
            return Ok(None);
        };
        if update.version != metadata.version {
            return Err("Cached update versions do not match".into());
        }
        validate_transport(&update)?;
        let bytes = read(self.package(&metadata.version)?)
            .map_err(|error| format!("Could not read the cached installer: {error}"))?;
        update
            .verify(&bytes)
            .map_err(|error| format!("Cached installer verification failed: {error}"))?;
        Ok(Some((update, bytes)))
    }

    fn store(&self, update: &Update, bytes: &[u8], rollback: bool) -> Result<(), String> {
        validate_transport(update)?;
        update
            .verify(bytes)
            .map_err(|error| format!("Installer verification failed: {error}"))?;
        let previous = self.metadata()?;
        create_dir_all(&self.directory)
            .map_err(|error| format!("Could not create the update cache: {error}"))?;
        super::replace_file(&self.package(&update.version)?, bytes)?;
        let metadata = CachedRelease {
            version: update.version.clone(),
            raw: update.raw_json.clone(),
            rollback,
        };
        let json = serde_json::to_vec(&metadata)
            .map_err(|error| format!("Could not encode update metadata: {error}"))?;
        super::replace_file(&self.directory.join("pending.json"), &json)?;
        if let Some(previous) = previous {
            if previous.version != update.version {
                if let Err(error) = self.remove_package(&previous.version) {
                    super::log(&error);
                }
            }
        }
        Ok(())
    }
}

fn configured_updater<R: tauri::Runtime>(
    app: &AppHandle<R>,
    include_prereleases: bool,
    rollback: bool,
    manifest: Option<reqwest::Url>,
) -> Result<Updater, String> {
    let handle = app.clone();
    let mut builder = app
        .updater_builder()
        .version_comparator(move |current, release| {
            eligible(&current, &release.version, include_prereleases, rollback)
        })
        .timeout(Duration::from_secs(15))
        .on_before_exit(move || {
            if let Some(sidecar) = handle.try_state::<super::Sidecar>() {
                sidecar.stop();
            }
        });
    if let Some(manifest) = manifest {
        builder = builder
            .endpoints(vec![manifest])
            .map_err(|error| format!("Could not select the update manifest: {error}"))?;
    }
    builder
        .build()
        .map_err(|error| format!("Could not initialise app updates: {error}"))
}

fn prereleases_enabled(app: &AppHandle) -> Result<bool, String> {
    let Some(text) = super::read_store(app.clone(), super::Store::Settings)? else {
        return Ok(false);
    };
    let settings: Value = serde_json::from_str(&text)
        .map_err(|error| format!("Could not read update preferences: {error}"))?;
    if !settings.is_object() {
        return Err("The app settings file does not contain valid update preferences".into());
    }
    Ok(settings["appIncludePrereleases"].as_str() == Some("true"))
}

impl AppUpdates {
    pub fn new(app: &AppHandle) -> Self {
        let directory = app.path().app_cache_dir();
        let mut status = Status {
            revision: 0,
            current_version: app.package_info().version.to_string(),
            action: Action::Idle,
            available: None,
            ready: false,
            downloaded: 0,
            total: None,
            checked_at: None,
            error: None,
            install_supported: cfg!(all(target_os = "windows", not(debug_assertions))),
            current_prerelease: !app.package_info().version.pre.is_empty(),
            include_prereleases: false,
            stable_version: None,
            rollback: false,
        };
        let cache = match directory {
            Ok(directory) => Some(Cache {
                directory: directory.join(if cfg!(debug_assertions) {
                    "updates-dev"
                } else {
                    "updates"
                }),
            }),
            Err(error) => {
                status.error = Some(format!("Could not locate the update cache: {error}"));
                status.install_supported = false;
                None
            }
        };
        let mut offer = None;
        if let Some(cache) = &cache {
            let restored = prereleases_enabled(app).and_then(|include| {
                status.include_prereleases = include;
                cache.restore_for(app, include)
            });
            match restored {
                Ok(Some((update, bytes, rollback))) => {
                    status.available = Some(release(&update));
                    status.rollback = rollback;
                    if rollback {
                        status.stable_version = Some(update.version.clone());
                    }
                    status.ready = true;
                    status.downloaded = bytes.len() as u64;
                    status.total = Some(bytes.len() as u64);
                    offer = Some(update);
                }
                Ok(None) => {}
                Err(error) => {
                    super::log(&error);
                    status.error = Some(error);
                    if let Err(error) = cache.discard_pointer() {
                        super::log(&error);
                    }
                }
            }
        }
        Self {
            inner: Arc::new(Mutex::new(Inner { status, offer })),
            cache,
        }
    }

    pub fn status(&self) -> Status {
        self.inner.lock().unwrap().status.clone()
    }

    fn emit(&self, app: &AppHandle) {
        if let Err(error) = app.emit(EVENT, self.status()) {
            super::log(&format!("Could not report app update progress: {error}"));
        }
    }

    fn begin(&self, app: &AppHandle, action: Action) -> Result<(), String> {
        let mut inner = self.inner.lock().unwrap();
        if inner.status.action != Action::Idle {
            return Err("Another app update operation is already running".into());
        }
        inner.status.action = action;
        inner.status.error = None;
        inner.status.revision += 1;
        if action == Action::Downloading {
            inner.status.downloaded = 0;
            inner.status.total = None;
        }
        drop(inner);
        self.emit(app);
        Ok(())
    }

    fn finish(&self, app: &AppHandle, result: Result<(), String>) -> Result<Status, String> {
        let mut inner = self.inner.lock().unwrap();
        inner.status.action = Action::Idle;
        inner.status.revision += 1;
        inner.status.error = result.as_ref().err().cloned();
        if let Err(error) = &result {
            super::log(error);
        }
        drop(inner);
        self.emit(app);
        result.map(|()| self.status())
    }

    pub async fn check(
        &self,
        app: &AppHandle,
        include_prereleases: bool,
        rollback: bool,
    ) -> Result<Status, String> {
        self.begin(app, Action::Checking)?;
        let result = async {
            if rollback && app.package_info().version.pre.is_empty() {
                return Err(
                    "Only an installed prerelease can return to an earlier stable version".into(),
                );
            }
            if rollback && include_prereleases {
                return Err("Turn prerelease updates off before returning to stable".into());
            }
            {
                let mut inner = self.inner.lock().unwrap();
                if inner.status.rollback != rollback
                    || (!include_prereleases
                        && inner
                            .status
                            .available
                            .as_ref()
                            .is_some_and(|offer| offer.prerelease))
                {
                    inner.clear_offer(self.cache.as_ref())?;
                }
                inner.status.include_prereleases = include_prereleases;
                inner.status.rollback = rollback;
                inner.status.revision += 1;
            }
            self.emit(app);
            let releases = published_releases().await?;
            let stable_version = releases
                .stable
                .as_ref()
                .map(|release| release.version.to_string());
            let candidate = if rollback {
                Some(
                    releases
                        .stable
                        .as_ref()
                        .ok_or("There is no published stable release to return to")?,
                )
            } else {
                releases.newest(include_prereleases)
            };
            let update = if let Some(candidate) = candidate.filter(|candidate| {
                eligible(
                    &app.package_info().version,
                    &candidate.version,
                    include_prereleases,
                    rollback,
                )
            }) {
                let update = configured_updater(
                    app,
                    include_prereleases,
                    rollback,
                    Some(candidate.manifest.clone()),
                )?
                .check()
                .await
                .map_err(|error| format!("Could not check the selected app release: {error}"))?
                .ok_or("The release manifest did not describe the selected version")?;
                let manifest_version = semver::Version::parse(&update.version)
                    .map_err(|error| format!("Invalid manifest version: {error}"))?;
                if manifest_version != candidate.version {
                    return Err("The update manifest version does not match its release tag".into());
                }
                validate_transport(&update)?;
                Some(update)
            } else {
                None
            };
            let mut inner = self.inner.lock().unwrap();
            inner.status.stable_version = stable_version;
            inner.replace_offer(update, self.cache.as_ref())
        }
        .await;
        self.finish(app, result)
    }

    pub async fn download(&self, app: &AppHandle) -> Result<Status, String> {
        self.begin(app, Action::Downloading)?;
        let result = async {
            let mut update = self
                .inner
                .lock()
                .unwrap()
                .offer
                .clone()
                .ok_or("Check for an available update before downloading")?;
            let cache = self
                .cache
                .as_ref()
                .ok_or("The update cache is unavailable")?;
            update.timeout = Some(Duration::from_secs(900));
            let mut last = Instant::now() - Duration::from_secs(1);
            let bytes = update
                .download(
                    |chunk, total| {
                        let mut inner = self.inner.lock().unwrap();
                        inner.status.downloaded += chunk as u64;
                        inner.status.revision += 1;
                        inner.status.total = total;
                        drop(inner);
                        if last.elapsed() >= Duration::from_millis(100) {
                            self.emit(app);
                            last = Instant::now();
                        }
                    },
                    || {},
                )
                .await
                .map_err(|error| format!("Could not download the app update: {error}"))?;
            let rollback = self.inner.lock().unwrap().status.rollback;
            cache.store(&update, &bytes, rollback)?;
            let mut inner = self.inner.lock().unwrap();
            inner.status.ready = true;
            inner.status.revision += 1;
            inner.status.downloaded = bytes.len() as u64;
            inner.status.total = Some(bytes.len() as u64);
            Ok(())
        }
        .await;
        self.finish(app, result)
    }

    pub fn install(&self, app: &AppHandle) -> Result<Status, String> {
        if !self.status().install_supported {
            return Err(
                "Install updates from an installed Windows build, not the development app".into(),
            );
        }
        self.begin(app, Action::Installing)?;
        let result = (|| {
            let (expected, expected_rollback) = {
                let inner = self.inner.lock().unwrap();
                if !inner.status.ready {
                    return Err("No downloaded app update is ready to install".into());
                }
                (
                    inner.offer.clone().ok_or("No app update was selected")?,
                    inner.status.rollback,
                )
            };
            let cache = self
                .cache
                .as_ref()
                .ok_or("The update cache is unavailable")?;
            let restored =
                prereleases_enabled(app).and_then(|include| cache.restore_for(app, include));
            let (update, bytes, rollback) = match restored {
                Ok(Some(restored)) => restored,
                result => {
                    self.inner.lock().unwrap().status.ready = false;
                    if let Err(error) = cache.discard_pointer() {
                        super::log(&error);
                    }
                    return match result {
                        Err(error) => Err(error),
                        Ok(None) => Err("No downloaded app update is ready to install".into()),
                        Ok(Some(_)) => unreachable!(),
                    };
                }
            };
            if update.version != expected.version
                || update.signature != expected.signature
                || rollback != expected_rollback
            {
                self.inner.lock().unwrap().status.ready = false;
                return Err("The downloaded update no longer matches the selected release. Check for updates again.".into());
            }
            update
                .install(&bytes)
                .map_err(|error| format!("Could not install the app update: {error}"))
        })();
        self.finish(app, result)
    }

    pub fn install_on_start(&self, app: &AppHandle) {
        let status = self.status();
        if status.ready && status.install_supported {
            if let Err(error) = self.install(app) {
                super::log(&format!(
                    "The downloaded app update could not be installed at startup: {error}"
                ));
            }
        }
    }
}

fn release(update: &Update) -> Release {
    Release {
        version: update.version.clone(),
        notes: update.body.clone(),
        prerelease: semver::Version::parse(&update.version)
            .is_ok_and(|version| !version.pre.is_empty()),
    }
}

#[tauri::command]
pub fn app_update_status(state: State<'_, AppUpdates>) -> Status {
    state.status()
}

#[tauri::command]
pub async fn app_update_check(
    app: AppHandle,
    state: State<'_, AppUpdates>,
    include_prereleases: bool,
    rollback: bool,
) -> Result<Status, String> {
    state.check(&app, include_prereleases, rollback).await
}

#[tauri::command]
pub async fn app_update_download(
    app: AppHandle,
    state: State<'_, AppUpdates>,
) -> Result<Status, String> {
    state.download(&app).await
}

#[tauri::command]
pub async fn app_update_install(
    app: AppHandle,
    state: State<'_, AppUpdates>,
) -> Result<Status, String> {
    let updates = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || updates.install(&app))
        .await
        .map_err(|error| format!("The installer task failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};
    use tempfile::{tempdir, TempDir};

    struct Fixture {
        directory: TempDir,
        key: PathBuf,
        public: String,
        updater: Updater,
    }

    fn test_app(public: &str, current: &str) -> tauri::App<tauri::test::MockRuntime> {
        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        context.package_info_mut().version = semver::Version::parse(current).unwrap();
        context.config_mut().plugins.0.insert(
            "updater".into(),
            serde_json::json!({
                "pubkey": public.trim(),
                "endpoints": ["https://example.invalid/latest.json"],
                "requireSignedVersion": true
            }),
        );
        tauri::test::mock_builder()
            .plugin(tauri_plugin_updater::Builder::new().build())
            .build(context)
            .unwrap()
    }

    fn test_updater(public: &str, current: &str, include: bool, rollback: bool) -> Updater {
        let app = test_app(public, current);
        app.updater_builder()
            .target("fixture")
            .version_comparator(move |current, release| {
                eligible(&current, &release.version, include, rollback)
            })
            .build()
            .unwrap()
    }

    fn signer() -> Command {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_owned();
        let mut command = Command::new("node");
        command
            .arg(
                root.join("node_modules")
                    .join("@tauri-apps")
                    .join("cli")
                    .join("tauri.js"),
            )
            .arg("signer")
            .env_remove("TAURI_SIGNING_PRIVATE_KEY")
            .env_remove("TAURI_SIGNING_PRIVATE_KEY_PATH")
            .env_remove("TAURI_SIGNING_PRIVATE_KEY_PASSWORD")
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        command
    }

    impl Fixture {
        fn new() -> Self {
            let directory = tempdir().unwrap();
            let key = directory.path().join("test.key");
            assert!(signer()
                .args(["generate", "--ci", "--password", "", "--write-keys"])
                .arg(&key)
                .status()
                .expect("Node and the installed Tauri CLI are required for signature tests")
                .success());
            let public = read_to_string(directory.path().join("test.key.pub")).unwrap();
            let updater = test_updater(&public, "0.1.0", true, false);
            Self {
                directory,
                key,
                public,
                updater,
            }
        }

        fn update(&self, version: &str, bytes: &[u8], bind_version: bool) -> Update {
            let path = self.directory.path().join(format!("fixture-{version}.bin"));
            std::fs::write(&path, bytes).unwrap();
            let mut command = signer();
            command
                .args(["sign", "--private-key-path"])
                .arg(&self.key)
                .args(["--password", ""]);
            if bind_version {
                command.args(["--app-version", version]);
            }
            assert!(command.arg(&path).status().unwrap().success());
            let signature = read_to_string(path.with_extension("bin.sig")).unwrap();
            let installer = serde_json::json!({
                "url": "https://example.invalid/fixture-setup.exe",
                "signature": signature.trim()
            });
            let mut platforms = serde_json::Map::new();
            platforms.insert("fixture".into(), installer.clone());
            platforms.insert(tauri_plugin_updater::target().unwrap(), installer);
            self.updater
                .restore_update(serde_json::json!({
                    "version": version,
                    "notes": "Fixture notes",
                    "platforms": platforms
                }))
                .unwrap()
                .unwrap()
        }

        fn cache(&self) -> Cache {
            Cache {
                directory: self.directory.path().join("cache"),
            }
        }

        fn staged(&self, update: Update, bytes: &[u8]) -> Inner {
            Inner {
                status: Status {
                    revision: 1,
                    current_version: update.current_version.clone(),
                    action: Action::Idle,
                    available: Some(release(&update)),
                    ready: true,
                    downloaded: bytes.len() as u64,
                    total: Some(bytes.len() as u64),
                    checked_at: None,
                    error: None,
                    install_supported: true,
                    current_prerelease: !semver::Version::parse(&update.current_version)
                        .unwrap()
                        .pre
                        .is_empty(),
                    include_prereleases: false,
                    stable_version: None,
                    rollback: false,
                },
                offer: Some(update),
            }
        }
    }

    #[test]
    fn cached_update_is_verified_and_restored_without_network() {
        let fixture = Fixture::new();
        let bytes = b"signed fixture package";
        let update = fixture.update("99.0.0", bytes, true);
        let cache = fixture.cache();
        cache.store(&update, bytes, false).unwrap();

        let (restored, saved) = cache.restore(&fixture.updater).unwrap().unwrap();
        assert_eq!(restored.version, "99.0.0");
        assert_eq!(saved, bytes);
    }

    #[test]
    fn modified_cached_package_is_rejected() {
        let fixture = Fixture::new();
        let bytes = b"signed fixture package";
        let update = fixture.update("99.0.0", bytes, true);
        let cache = fixture.cache();
        cache.store(&update, bytes, false).unwrap();
        std::fs::write(cache.package("99.0.0").unwrap(), b"tampered").unwrap();

        let error = cache.restore(&fixture.updater).err().unwrap();
        assert!(error.contains("verification failed"), "{error}");
    }

    #[test]
    fn invalid_bytes_are_not_staged() {
        let fixture = Fixture::new();
        let update = fixture.update("99.0.0", b"original", true);
        let cache = fixture.cache();

        assert!(cache.store(&update, b"changed", false).is_err());
        assert!(!cache.directory.join("pending.json").exists());
    }

    #[test]
    fn cached_metadata_cannot_inflate_a_signed_version() {
        let fixture = Fixture::new();
        let bytes = b"signed fixture package";
        let update = fixture.update("99.0.0", bytes, true);
        let cache = fixture.cache();
        cache.store(&update, bytes, false).unwrap();
        let mut metadata = cache.metadata().unwrap().unwrap();
        metadata.version = "100.0.0".into();
        metadata.raw["version"] = serde_json::json!("100.0.0");
        std::fs::write(cache.package("100.0.0").unwrap(), bytes).unwrap();
        super::super::replace_file(
            &cache.directory.join("pending.json"),
            &serde_json::to_vec(&metadata).unwrap(),
        )
        .unwrap();

        let error = cache.restore(&fixture.updater).err().unwrap();
        assert!(error.contains("verification failed"), "{error}");
    }

    #[test]
    fn unsigned_versions_are_rejected_even_for_valid_package_signatures() {
        let fixture = Fixture::new();
        let bytes = b"legacy signed package";
        let update = fixture.update("99.0.0", bytes, false);

        assert!(fixture.cache().store(&update, bytes, false).is_err());
    }

    #[test]
    fn another_signing_key_cannot_authorise_the_cached_package() {
        let fixture = Fixture::new();
        let other = Fixture::new();
        let bytes = b"signed fixture package";
        let update = fixture.update("99.0.0", bytes, true);
        let cache = fixture.cache();
        cache.store(&update, bytes, false).unwrap();

        assert!(cache.restore(&other.updater).is_err());
    }

    #[test]
    fn replacing_a_staged_update_removes_the_previous_package() {
        let fixture = Fixture::new();
        let cache = fixture.cache();
        let first = fixture.update("99.0.0", b"first", true);
        cache.store(&first, b"first", false).unwrap();
        let next = fixture.update("100.0.0", b"next", true);
        cache.store(&next, b"next", false).unwrap();

        assert!(!cache.package("99.0.0").unwrap().exists());
        assert_eq!(
            cache.restore(&fixture.updater).unwrap().unwrap().0.version,
            "100.0.0"
        );
    }

    #[test]
    fn a_matching_feed_keeps_the_verified_download_ready() {
        let fixture = Fixture::new();
        let bytes = b"signed fixture package";
        let update = fixture.update("99.0.0", bytes, true);
        let cache = fixture.cache();
        cache.store(&update, bytes, false).unwrap();
        let mut inner = fixture.staged(update.clone(), bytes);

        inner.replace_offer(Some(update), Some(&cache)).unwrap();

        assert!(inner.status.ready);
        assert_eq!(inner.status.downloaded, bytes.len() as u64);
        assert!(cache.restore(&fixture.updater).unwrap().is_some());
    }

    #[test]
    fn a_withdrawn_release_cannot_install_from_a_previous_download_on_restart() {
        let fixture = Fixture::new();
        let bytes = b"signed fixture package";
        let update = fixture.update("99.0.0", bytes, true);
        let cache = fixture.cache();
        cache.store(&update, bytes, false).unwrap();
        let mut inner = fixture.staged(update, bytes);

        inner.replace_offer(None, Some(&cache)).unwrap();

        assert!(!inner.status.ready);
        assert!(inner.status.available.is_none());
        assert!(inner.offer.is_none());
        assert!(cache.restore(&fixture.updater).unwrap().is_none());
        assert!(!cache.package("99.0.0").unwrap().exists());
    }

    #[test]
    fn a_new_feed_does_not_leave_an_older_release_scheduled_for_restart() {
        let fixture = Fixture::new();
        let first = fixture.update("99.0.0", b"first", true);
        let cache = fixture.cache();
        cache.store(&first, b"first", false).unwrap();
        let mut inner = fixture.staged(first, b"first");
        let next = fixture.update("100.0.0", b"next", true);

        inner.replace_offer(Some(next), Some(&cache)).unwrap();

        assert!(!inner.status.ready);
        assert_eq!(inner.status.available.unwrap().version, "100.0.0");
        assert_eq!(inner.status.downloaded, 0);
        assert!(cache.restore(&fixture.updater).unwrap().is_none());
    }

    #[test]
    fn an_already_installed_version_is_discarded_without_installing_again() {
        let fixture = Fixture::new();
        let bytes = b"signed fixture package";
        let update = fixture.update("99.0.0", bytes, true);
        let cache = fixture.cache();
        cache.store(&update, bytes, false).unwrap();
        let mut metadata = cache.metadata().unwrap().unwrap();
        metadata.version = update.current_version.clone();
        metadata.raw["version"] = serde_json::json!(update.current_version);
        std::fs::write(cache.package(&metadata.version).unwrap(), bytes).unwrap();
        super::super::replace_file(
            &cache.directory.join("pending.json"),
            &serde_json::to_vec(&metadata).unwrap(),
        )
        .unwrap();

        assert!(cache.restore(&fixture.updater).unwrap().is_none());
        assert!(!cache.directory.join("pending.json").exists());
        assert!(!cache.package(&metadata.version).unwrap().exists());
    }

    #[test]
    fn cache_paths_cannot_leave_the_updates_directory() {
        let directory = tempdir().unwrap();
        let cache = Cache {
            directory: directory.path().to_owned(),
        };
        for version in ["../outside", "..\\outside", "a/b", "", "a\0b"] {
            assert!(cache.package(version).is_err(), "{version:?}");
        }
        assert!(cache
            .package("1.2.3")
            .unwrap()
            .starts_with(directory.path()));
    }

    #[test]
    fn update_packages_require_https_transport() {
        let fixture = Fixture::new();
        let bytes = b"signed fixture package";
        let mut update = fixture.update("99.0.0", bytes, true);
        update.download_url = "http://example.invalid/update.exe".parse().unwrap();
        assert!(fixture.cache().store(&update, bytes, false).is_err());
    }

    #[test]
    fn a_cached_prerelease_is_discarded_when_the_user_opts_out() {
        let fixture = Fixture::new();
        let bytes = b"beta package";
        let update = fixture.update("99.0.0-beta.2", bytes, true);
        let cache = fixture.cache();
        cache.store(&update, bytes, false).unwrap();
        let app = test_app(&fixture.public, "98.0.0");
        assert!(cache.restore_for(app.handle(), true).unwrap().is_some());

        assert!(cache.restore_for(app.handle(), false).unwrap().is_none());
        assert!(!cache.package("99.0.0-beta.2").unwrap().exists());
    }

    #[test]
    fn an_explicit_stable_rollback_survives_restart_without_allowing_general_downgrades() {
        let fixture = Fixture::new();
        let bytes = b"stable package";
        let update = fixture.update("98.0.0", bytes, true);
        let cache = fixture.cache();
        cache.store(&update, bytes, true).unwrap();
        assert!(cache.metadata().unwrap().unwrap().rollback);

        let app = test_app(&fixture.public, "99.0.0-beta.2");
        assert_eq!(
            cache
                .restore_for(app.handle(), false)
                .unwrap()
                .unwrap()
                .0
                .version,
            "98.0.0"
        );

        let ordinary = test_updater(&fixture.public, "99.0.0-beta.2", false, false);
        assert!(cache.restore(&ordinary).unwrap().is_none());
    }

    #[test]
    fn opting_back_into_prereleases_cancels_a_pending_stable_return() {
        let fixture = Fixture::new();
        let bytes = b"stable package";
        let update = fixture.update("98.0.0", bytes, true);
        let cache = fixture.cache();
        cache.store(&update, bytes, true).unwrap();
        let app = test_app(&fixture.public, "99.0.0-beta.2");

        assert!(cache.restore_for(app.handle(), true).unwrap().is_none());
        assert!(!cache.directory.join("pending.json").exists());
    }

    #[test]
    fn a_stable_installation_never_restores_an_older_package_as_a_rollback() {
        let fixture = Fixture::new();
        let bytes = b"older stable package";
        let update = fixture.update("98.0.0", bytes, true);
        let cache = fixture.cache();
        cache.store(&update, bytes, true).unwrap();
        let stable = test_updater(&fixture.public, "99.0.0", false, true);

        assert!(cache.restore(&stable).unwrap().is_none());
    }

    #[test]
    fn shipped_configuration_requires_version_bound_updater_signatures() {
        let configuration: Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(
            configuration["plugins"]["updater"]["requireSignedVersion"],
            true
        );
        assert_eq!(configuration["bundle"]["createUpdaterArtifacts"], true);
        assert!(configuration["plugins"]["updater"]["endpoints"][0]
            .as_str()
            .unwrap()
            .starts_with("https://"));
    }

    #[test]
    #[ignore = "requires signed installer artifacts and UPDATER_ARTIFACTS_DIR"]
    fn release_artifacts_match_the_configured_public_key_and_version() {
        let directory = PathBuf::from(
            std::env::var_os("UPDATER_ARTIFACTS_DIR").expect("UPDATER_ARTIFACTS_DIR is required"),
        );
        let configuration: Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        context.config_mut().plugins.0.insert(
            "updater".into(),
            configuration["plugins"]["updater"].clone(),
        );
        let app = tauri::test::mock_builder()
            .plugin(tauri_plugin_updater::Builder::new().build())
            .build(context)
            .unwrap();
        let metadata: Value =
            serde_json::from_str(&read_to_string(directory.join("latest.json")).unwrap()).unwrap();
        for target in ["windows-x86_64-nsis", "windows-x86_64-msi"] {
            let updater = app
                .updater_builder()
                .target(target)
                .version_comparator(|_, _| true)
                .build()
                .unwrap();
            let update = updater.restore_update(metadata.clone()).unwrap().unwrap();
            let filename = update
                .download_url
                .path_segments()
                .unwrap()
                .next_back()
                .unwrap();
            let package = read(directory.join(filename)).unwrap();
            update
                .verify(&package)
                .expect("installer signature and signed version must match the shipped public key");
        }
    }
}
