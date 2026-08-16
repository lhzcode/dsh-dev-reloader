const SAFE_PROFILE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

/** Profiles are one portable path segment on POSIX and Windows. */
export function isSafeProfileName(profile: string): boolean {
  return SAFE_PROFILE_NAME.test(profile) && profile !== '.' && profile !== '..'
}

export function requireSafeProfileName(profile: unknown, label = 'profile'): string {
  if (typeof profile !== 'string' || !isSafeProfileName(profile)) {
    throw new Error(`invalid DSH ${label} name: ${String(profile)}`)
  }
  return profile
}
