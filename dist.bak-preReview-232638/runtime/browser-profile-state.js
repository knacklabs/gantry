import fs from 'fs';
import path from 'path';
export function hasPersistentBrowserState(profile) {
    if (fs.existsSync(profile.statePath))
        return true;
    for (const relativePath of [
        path.join('Default', 'Cookies'),
        path.join('Default', 'Login Data'),
        'Local State',
    ]) {
        try {
            const fullPath = path.join(profile.userDataDir, relativePath);
            const stat = fs.statSync(fullPath);
            if (stat.isFile() && stat.size > 0)
                return true;
        }
        catch {
            // ignore missing or unreadable Chrome state files
        }
    }
    return false;
}
export function inferAuthMarkers(profile) {
    const markers = new Set();
    for (const relativePath of [
        path.join('Default', 'Cookies'),
        path.join('Default', 'Login Data'),
    ]) {
        try {
            const fullPath = path.join(profile.userDataDir, relativePath);
            const stat = fs.statSync(fullPath);
            if (stat.isFile() && stat.size > 0) {
                markers.add(relativePath === path.join('Default', 'Cookies')
                    ? 'cookies'
                    : 'login-data');
            }
        }
        catch {
            // ignore missing or unreadable Chrome state files
        }
    }
    return [...markers].sort();
}
