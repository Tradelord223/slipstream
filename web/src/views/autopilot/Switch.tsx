/** A labelled on/off switch. The whole row is the button, so it's an easy target on a phone. */
export function Switch({ checked, label, hint, onChange, disabled }: { checked: boolean; label: string; hint?: string; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} className="ap-switch" disabled={disabled} onClick={() => onChange(!checked)}>
      <span className="ap-switch-track" aria-hidden="true">
        <span />
      </span>
      <span className="ap-switch-text">
        <span className="ap-switch-label">{label}</span>
        {hint && <span className="ap-switch-hint">{hint}</span>}
      </span>
    </button>
  );
}
