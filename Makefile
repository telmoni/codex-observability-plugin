.PHONY: check
# The gate: types, the bundle and the suites, the manifests and the package
# among them, since Codex ships no validator for a plugin or a marketplace.
# Needs Node 22.23.4, 24.22.1 or 26.12.1 or later, and npm.
check:
	npm run verify
