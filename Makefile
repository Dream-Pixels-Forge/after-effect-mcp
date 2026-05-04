.PHONY: test build smoke check-afterfx test-live install-opencode

test:
	npm test

build:
	npm run build

smoke:
	npm run smoke

check-afterfx:
	npm run check:afterfx

test-live:
	npm run test:live

install-opencode:
	npm run install:opencode
