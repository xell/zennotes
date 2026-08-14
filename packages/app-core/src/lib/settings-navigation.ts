export type SettingsNavigationTarget = "cloud";

let pendingSettingsTarget: SettingsNavigationTarget | null = null;

export function requestSettingsTarget(target: SettingsNavigationTarget): void {
  pendingSettingsTarget = target;
}

export function consumeSettingsTarget(): SettingsNavigationTarget | null {
  const target = pendingSettingsTarget;
  pendingSettingsTarget = null;
  return target;
}
