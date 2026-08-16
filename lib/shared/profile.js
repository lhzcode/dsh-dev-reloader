const SAFE_PROFILE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
/** Profiles are one portable path segment on POSIX and Windows. */
export function isSafeProfileName(profile) {
    return SAFE_PROFILE_NAME.test(profile) && profile !== '.' && profile !== '..';
}
export function requireSafeProfileName(profile, label = 'profile') {
    if (typeof profile !== 'string' || !isSafeProfileName(profile)) {
        throw new Error(`invalid DSH ${label} name: ${String(profile)}`);
    }
    return profile;
}
//# sourceMappingURL=profile.js.map