const test = require('node:test');
const assert = require('node:assert/strict');
const { SUBHD_HOSTS, SUBHD_MIRRORS, subhdDnrRegexFilter } = require('../src/subhd_config');

test('SubHD mirrors are a subset of known hosts', () => {
    assert.ok(SUBHD_MIRRORS.length > 0);
    for (const url of SUBHD_MIRRORS) {
        assert.ok(SUBHD_HOSTS.some(host => url === 'https://' + host), url);
    }
});

test('SubHD DNR regex covers every known host', () => {
    const filter = subhdDnrRegexFilter();
    const regex = new RegExp(filter);
    for (const host of SUBHD_HOSTS) {
        assert.ok(regex.test('https://' + host + '/api/sub/down'), host);
    }
    assert.equal(regex.test('https://example.com/api/sub/down'), false);
});

test('SubHD DNR regex escapes dots', () => {
    assert.ok(subhdDnrRegexFilter().includes('subhd\\.me'));
});
