export const THEME_MODES = ["auto", "light", "dark"] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

const THEME_LABELS: Record<ThemeMode, string> = {
  auto: "Auto theme",
  light: "Light theme",
  dark: "Dark theme",
};

export function initialThemeMode(): ThemeMode {
  const stored = localStorage.getItem("themeMode");
  return THEME_MODES.includes(stored as ThemeMode) ? (stored as ThemeMode) : "auto";
}

function ThemeIcon({ mode }: { mode: ThemeMode }) {
  if (mode === "light") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2.5M12 19.5V22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M2 12h2.5M19.5 12H22M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8" />
      </svg>
    );
  }

  if (mode === "dark") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M20.5 14.7A8.4 8.4 0 0 1 9.3 3.5a8.5 8.5 0 1 0 11.2 11.2Z" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z" />
      <path d="M12 3v18M12 7a5 5 0 0 1 0 10" />
    </svg>
  );
}

export function ThemeSwitcher({
  value,
  onChange,
}: {
  value: ThemeMode;
  onChange: (mode: ThemeMode) => void;
}) {
  return (
    <div className="theme-switcher" role="group" aria-label="Theme">
      {THEME_MODES.map((mode) => (
        <button
          key={mode}
          type="button"
          className={value === mode ? "theme-option active" : "theme-option"}
          onClick={() => onChange(mode)}
          title={THEME_LABELS[mode]}
          aria-label={THEME_LABELS[mode]}
          aria-pressed={value === mode}
        >
          <ThemeIcon mode={mode} />
        </button>
      ))}
    </div>
  );
}
