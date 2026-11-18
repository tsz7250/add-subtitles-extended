// Single source of truth for SubHD hosts, shared by the background worker
// (permissions + DNR rule) and the content script (mirror rotation).
// [reason] hosts drift over time; keep the list here so no caller hardcodes it.
const SUBHD_HOSTS = ['subhd.me', 'subhd.tv', 'subhd.one', 'subhdtw.com', 'subhd.top', 'subhd.cc'];

// shortcut: subhd.tv is recognised (permissions, DNR, isSubhdUrl) but intentionally
// not rotated for search — it is flagged "possibly walled" by the site itself.
// Upgrade when the site starts serving search from it reliably.
const SUBHD_MIRRORS = SUBHD_HOSTS
    .filter(function(host){ return host !== 'subhd.tv'; })
    .map(function(host){ return 'https://' + host; });

function subhdDnrRegexFilter() {
    const escaped = SUBHD_HOSTS.map(function(host){
        return host.replace(/\./g, '\\.');
    }).join('|');
    return '^https://(' + escaped + ')/api/sub/';
}

module.exports = {
    SUBHD_HOSTS,
    SUBHD_MIRRORS,
    subhdDnrRegexFilter
};
