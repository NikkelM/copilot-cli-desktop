// @vitest-environment jsdom
import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Dropdown } from './Dropdown';

const options = [
  { value: 'one', label: 'One' }, { value: 'two', label: 'Two' }, { value: 'three', label: 'Three' },
];

describe('app dropdown', () => {
  it('draws the selected value and uses an app menu instead of a native select', async () => {
    const onChange = vi.fn();
    const { container } = render(<Dropdown label="Choice" value="two" options={options} onChange={onChange} />);
    expect(container.querySelector('select')).toBeNull();
    const control = screen.getByRole('combobox', { name: 'Choice' });
    expect(control.classList.contains('field')).toBe(true);
    expect(control.textContent).toContain('Two');
    await userEvent.click(control);
    expect(control.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('listbox')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('option', { name: 'Two' }));
    await userEvent.click(screen.getByRole('option', { name: 'Three' }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith('three');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(document.activeElement).toBe(control);
  });

  it('offers a compact variant for toolbar controls', () => {
    render(<Dropdown label="Choice" value="one" options={options} onChange={vi.fn()} variant="compact" />);
    expect(screen.getByRole('combobox').classList.contains('compact')).toBe(true);
    expect(screen.getByRole('combobox').classList.contains('field')).toBe(false);
  });
  it('supports arrows, Home, End, type-ahead and Enter selection', async () => {
    const onChange = vi.fn();
    render(<Dropdown label="Choice" value="one" options={options} onChange={onChange} />);
    screen.getByRole('combobox').focus();
    await userEvent.keyboard('{ArrowDown}{End}');
    expect(document.activeElement).toBe(screen.getByRole('option', { name: 'Three' }));
    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(screen.getByRole('option', { name: 'One' }));
    await userEvent.keyboard('{ArrowUp}{Home}t');
    expect(document.activeElement).toBe(screen.getByRole('option', { name: 'Two' }));
    await userEvent.keyboard('{Enter}');
    expect(onChange).toHaveBeenCalledExactlyOnceWith('two');
  });

  it('dismisses on Escape without changing the value or closing its parent', async () => {
    const parent = vi.fn();
    const onChange = vi.fn();
    render(<div onKeyDown={parent}><Dropdown label="Choice" value="one" options={options} onChange={onChange} /></div>);
    await userEvent.click(screen.getByRole('combobox'));
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    expect(parent).not.toHaveBeenCalled();
  });

  it('can be labelled by an external label and refuses disabled controls', async () => {
    render(<><label htmlFor="choice">External label</label><Dropdown id="choice" label="External label"
      value="one" options={options} onChange={vi.fn()} disabled /></>);
    const control = screen.getByLabelText('External label');
    expect((control as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(control);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('reflects changed options and selection without holding a stale label', async () => {
    function Form() {
      const [value, setValue] = useState('one');
      return <Dropdown label="Choice" value={value} options={options} onChange={setValue} />;
    }
    const view = render(<Form />);
    await userEvent.click(screen.getByRole('combobox'));
    await userEvent.click(screen.getByRole('option', { name: 'Two' }));
    expect(screen.getByRole('combobox').textContent).toContain('Two');
    view.rerender(<Dropdown label="Choice" value="new" options={[{ value: 'new', label: 'New' }]} onChange={vi.fn()} />);
    expect(screen.getByRole('combobox').textContent).toContain('New');
    fireEvent.mouseDown(document.body);
  });
});
