PORT ?= 8000

.PHONY: serve
serve:
	@echo "Simulator: http://localhost:$(PORT)/"
	@python3 -m http.server $(PORT)
