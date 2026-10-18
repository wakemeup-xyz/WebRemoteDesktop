"""Pure four-existing-file policy. No I/O, operational imports or entrypoint."""
COPY_PATHS = (
    'scripts/ordinary_session_recovery.py',
    'scripts/test_ordinary_session_recovery.py',
    'web-client/js/webrtc.js',
    'web-client/js/webrtc.test.js',
)
BUILD_INPUTS = frozenset({
    'signal-server/scripts/build-web-client.js',
    'signal-server/scripts/web-asset-graph.js',
    'signal-server/lib/web-assets.js',
    'signal-server/package.json',
    'signal-server/package-lock.json',
})

def require(condition, message):
    if not condition:
        raise ValueError(message)

def validate_partition(canonical_rows, promoted_paths, not_promoted_paths):
    """Rows are exact canonical c802..final metadata, supplied by future source gate."""
    require(type(canonical_rows) is list and canonical_rows, 'canonical rows required')
    require(type(promoted_paths) is list and promoted_paths == list(COPY_PATHS), 'exact ordered four replacements')
    paths = []
    for row in canonical_rows:
        require(type(row) is dict and set(row) == {'path', 'status', 'oldMode', 'newMode'}, 'canonical row schema')
        path = row['path']
        require(type(path) is str and path and not path.startswith('/') and all(p not in ('', '.', '..') for p in path.split('/')), 'relative canonical path')
        require(path not in paths and row['newMode'] == '100644', 'unique regular canonical path')
        if path in COPY_PATHS:
            require(row['status'] == 'M' and row['oldMode'] == '100644', 'only existing replacements')
        else:
            require(path.startswith('docs/superpowers/') and row['status'] in ('A', 'M'), 'non-promoted docs only')
            require(row['oldMode'] == ('000000' if row['status'] == 'A' else '100644'), 'documentation mode/status')
        paths.append(path)
    require(set(COPY_PATHS).issubset(paths), 'all four canonical replacements required')
    require(type(not_promoted_paths) is list and not_promoted_paths == [p for p in paths if p not in COPY_PATHS], 'explicit complete ordered notPromoted partition')
    return tuple(paths)

def derive_post_map(before, replacements):
    """Input maps come from pinned historical records and reviewed frozen bytes."""
    require(type(before) is dict and len(before) == 1016, 'historical known map must contain 1016 regular files')
    require(type(replacements) is dict and set(replacements) == set(COPY_PATHS), 'four replacements only')
    after = dict(before)
    for path in COPY_PATHS:
        require(path in before, 'new primary paths forbidden')
        old, new = before[path], replacements[path]
        require(type(old) is dict and type(new) is dict and set(old) == set(new) == {'sha256', 'filesystemMode'}, 'regular file metadata schema')
        require(type(new['filesystemMode']) is int and new['filesystemMode'] == old['filesystemMode'], 'preserve actual existing file mode')
        require(type(new['sha256']) is str and len(new['sha256']) == 64 and all(c in '0123456789abcdef' for c in new['sha256']), 'reviewed replacement digest')
        after[path] = dict(new)
    require(set(after) == set(before) and len(after) == 1016, 'no known-map expansion')
    return after

def build_input_paths(source_tree_paths):
    """Freeze all Viewer inputs, independent of the four-file publication allowlist."""
    require(type(source_tree_paths) is set and all(type(p) is str for p in source_tree_paths), 'source tree path set')
    require(BUILD_INPUTS.issubset(source_tree_paths), 'complete unchanged builder input closure')
    inputs = {p for p in source_tree_paths if p.startswith('web-client/')} | BUILD_INPUTS
    require(not any(p.startswith('web-client/dist/') for p in inputs), 'generated dist cannot be a source input')
    return tuple(sorted(inputs))
