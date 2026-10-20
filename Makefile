# rgthree-comfy developer commands.
#
# Every target runs scripts/dev.ps1 through Windows PowerShell, so the same Makefile works with
#   - GNU Make inside WSL (the repo lives in WSL; powershell.exe is reachable through interop), and
#   - GNU Make on Windows (e.g. `choco install make`), from a Windows clone of the repo.
# No make? Run the script directly:  scripts\dev.cmd <target>   or
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/dev.ps1 <target>
#
# Optional variables:
#   INSTALL_DIR=<path>     installed custom node (default: Comfy Desktop's custom_nodes\rgthree-comfy)
#   BACKUP=<id|original>   which backup `make restore` uses (default: newest pre-deploy backup)
#   REF=<commit|main>      what `make reset-upstream` installs (default: the pinned, verified commit)
#   YES=1                  skip the typed confirmation prompts

POWERSHELL ?= powershell.exe
DEV = $(POWERSHELL) -NoProfile -ExecutionPolicy Bypass -File scripts/dev.ps1
OPTS = $(if $(INSTALL_DIR),-InstallDir "$(INSTALL_DIR)") $(if $(YES),-Yes)

.DEFAULT_GOAL := help
.PHONY: help setup status check build deploy backup backups restore restore-original upstream reset-upstream sandbox e2e clean

help:
	@$(DEV) help

setup:
	@$(DEV) setup

status:
	@$(DEV) status $(OPTS)

check:
	@$(DEV) check

build:
	@$(DEV) build

# deploy always builds first, so the copied web/ matches src_web/.
deploy: build
	@$(DEV) deploy $(OPTS)

backup:
	@$(DEV) backup $(OPTS)

backups:
	@$(DEV) backups $(OPTS)

restore:
	@$(DEV) restore $(OPTS) $(if $(BACKUP),-Backup "$(BACKUP)")

restore-original:
	@$(DEV) restore $(OPTS) -Backup original

upstream:
	@$(DEV) upstream $(OPTS)

reset-upstream:
	@$(DEV) reset-upstream $(OPTS) $(if $(REF),-Ref "$(REF)")

# A throw-away second ComfyUI (port 8288) running the dev build; never touches the real install.
sandbox: build
	@$(DEV) sandbox $(OPTS)

e2e:
	@$(DEV) e2e

clean:
	@$(DEV) clean
