# WorkLens — root Makefile.
#
# Every target is safe to run at any point in the build, including now, before
# most component directories exist: a target whose directory is absent prints
# "skipping: <dir>/ not yet present" and succeeds, so `make test` and `make ci`
# stay green while the monorepo is being filled in phase by phase.
#
# Run `make` or `make help` for the target list.

SHELL := /usr/bin/env bash
.SHELLFLAGS := -eu -o pipefail -c
.DEFAULT_GOAL := help

# Minimum tool versions, asserted by `make bootstrap`.
GO_MIN_VERSION        := 1.23
NODE_MIN_VERSION      := 22
TERRAFORM_MIN_VERSION := 1.9

# Agent cross-compilation target. Windows first; the platform seam in
# agent/internal/platform keeps a macOS build possible later.
AGENT_GOOS      := windows
AGENT_GOARCH    := amd64
AGENT_BIN_DIR   := bin
AGENT_LDFLAGS   := -s -w

# Lambda bundling is owned by backend/scripts/bundle.ts, which reads the function
# inventory from backend/functions.json — the same file infra/ reads, so what gets built
# and what gets deployed cannot drift. Bundling options (Node 22 target, deterministic
# zips, AWS SDK bundled rather than externalised) are documented in that script.
LAMBDA_ARTIFACTS := backend/artifacts

# Extra arguments passed through to terraform, e.g.
#   make tf-plan TF_ARGS="-target=module.database"
TF_ARGS ?=
TF_VAR_FILE := terraform.tfvars

##@ General

help: ## Show this help
	@awk 'BEGIN { FS = ":.*##" } \
		/^##@/ { printf "\n\033[1m%s\033[0m\n", substr($$0, 5); next } \
		/^[a-zA-Z0-9][a-zA-Z0-9_.-]*:.*##/ { \
			desc = $$2; sub(/^[ \t]+/, "", desc); \
			printf "  \033[36m%-16s\033[0m %s\n", $$1, desc } \
		END { printf "\n" }' $(MAKEFILE_LIST)

bootstrap: ## Verify required tool versions and install component dependencies
	@vercmp() { \
		awk -v have="$$1" -v want="$$2" 'BEGIN { \
			n = split(have, h, "."); split(want, w, "."); \
			for (i = 1; i <= 3; i++) { \
				hi = (i <= n) ? h[i] + 0 : 0; wi = w[i] + 0; \
				if (hi > wi) exit 0; if (hi < wi) exit 1 } \
			exit 0 }'; \
	}; \
	fail=0; \
	echo "Tool versions:"; \
	if command -v go >/dev/null 2>&1; then \
		v=$$(go version | awk '{ print $$3 }' | sed 's/^go//'); \
		if vercmp "$$v" "$(GO_MIN_VERSION)"; then echo "  go         $$v (need $(GO_MIN_VERSION)+)"; \
		else echo "  go         $$v is older than $(GO_MIN_VERSION) — upgrade from https://go.dev/dl/"; fail=1; fi; \
	else echo "  go         MISSING — install Go $(GO_MIN_VERSION)+ from https://go.dev/dl/"; fail=1; fi; \
	if command -v node >/dev/null 2>&1; then \
		v=$$(node --version | sed 's/^v//'); \
		if vercmp "$$v" "$(NODE_MIN_VERSION)"; then echo "  node       $$v (need $(NODE_MIN_VERSION)+)"; \
		else echo "  node       $$v is older than $(NODE_MIN_VERSION) — upgrade from https://nodejs.org/"; fail=1; fi; \
	else echo "  node       MISSING — install Node $(NODE_MIN_VERSION)+ from https://nodejs.org/"; fail=1; fi; \
	if command -v npm >/dev/null 2>&1; then echo "  npm        $$(npm --version)"; \
	else echo "  npm        MISSING — ships with Node $(NODE_MIN_VERSION)+"; fail=1; fi; \
	if command -v terraform >/dev/null 2>&1; then \
		v=$$(terraform version | head -1 | awk '{ print $$2 }' | sed 's/^v//'); \
		if vercmp "$$v" "$(TERRAFORM_MIN_VERSION)"; then echo "  terraform  $$v (need $(TERRAFORM_MIN_VERSION)+)"; \
		else echo "  terraform  $$v is older than $(TERRAFORM_MIN_VERSION) — upgrade from https://developer.hashicorp.com/terraform/downloads"; fail=1; fi; \
	else echo "  terraform  MISSING — install Terraform $(TERRAFORM_MIN_VERSION)+"; fail=1; fi; \
	if command -v gitleaks >/dev/null 2>&1; then echo "  gitleaks   $$(gitleaks version 2>/dev/null || echo present) (optional locally; enforced in CI)"; \
	else echo "  gitleaks   not installed (optional locally; CI runs it — see CONTRIBUTING.md)"; fi; \
	if [ "$$fail" -ne 0 ]; then echo; echo "bootstrap: required tooling is missing or out of date."; exit 1; fi; \
	echo; \
	if [ -f agent/go.mod ]; then echo "Downloading Go modules..."; cd agent && go mod download && cd ..; \
	else echo "skipping: agent/go.mod not yet present"; fi; \
	if [ -f backend/package.json ]; then echo "Installing backend dependencies..."; cd backend && npm ci && cd ..; \
	else echo "skipping: backend/package.json not yet present"; fi; \
	if [ -f dashboard/package.json ]; then echo "Installing dashboard dependencies..."; cd dashboard && npm ci && cd ..; \
	else echo "skipping: dashboard/package.json not yet present"; fi; \
	echo; echo "bootstrap: done."

##@ Whole repository

fmt: ## Format Go, TypeScript and Terraform sources in place
	@if [ -d agent ]; then echo "==> gofmt agent/"; gofmt -l -w agent; \
	else echo "skipping: agent/ not yet present"; fi
	@if [ -f backend/package.json ]; then echo "==> eslint --fix backend/"; \
		cd backend && npx --no-install eslint . --fix; \
	else echo "skipping: backend/ not yet present"; fi
	@if [ -f dashboard/package.json ]; then echo "==> eslint --fix dashboard/"; \
		cd dashboard && npx --no-install eslint . --fix; \
	else echo "skipping: dashboard/ not yet present"; fi
	@$(MAKE) --no-print-directory tf-fmt

lint: ## Lint every component without modifying files
	@if [ -d agent ]; then \
		echo "==> gofmt check agent/"; \
		unformatted=$$(gofmt -l agent); \
		if [ -n "$$unformatted" ]; then echo "gofmt would reformat:"; echo "$$unformatted"; exit 1; fi; \
		echo "==> go vet agent/"; cd agent && go vet ./...; \
	else echo "skipping: agent/ not yet present"; fi
	@if [ -f backend/package.json ]; then \
		echo "==> tsc --noEmit backend/"; cd backend && npx --no-install tsc --noEmit && npx --no-install eslint .; \
	else echo "skipping: backend/ not yet present"; fi
	@if [ -f dashboard/package.json ]; then \
		echo "==> tsc --noEmit dashboard/"; cd dashboard && npx --no-install tsc --noEmit && npx --no-install eslint .; \
	else echo "skipping: dashboard/ not yet present"; fi
	@$(MAKE) --no-print-directory tf-fmt-check

test: agent-test backend-test dashboard-test ## Run every test suite

build: agent-windows backend-build dashboard-build ## Build every component

ci: lint test build tf-validate check-privacy check-iam check-readme check-functions check-migrations check-routes ## Run everything CI runs

clean: ## Remove build artefacts, bundles, caches and Terraform plans
	@rm -rf $(AGENT_BIN_DIR) $(LAMBDA_ARTIFACTS)
	@rm -rf backend/dist backend/coverage backend/.eslintcache
	@rm -rf dashboard/.next dashboard/out dashboard/coverage dashboard/.eslintcache
	@rm -f infra/tfplan infra/bootstrap/tfplan
	@find . -name '*.tsbuildinfo' -not -path './node_modules/*' -delete
	@if [ -d agent ]; then cd agent && go clean -cache -testcache ./... 2>/dev/null || true; fi
	@echo "clean: done."

##@ Agent (Go)

agent-windows: ## Cross-compile both agent binaries for Windows amd64 into bin/
	@if [ ! -f agent/go.mod ]; then echo "skipping: agent/ not yet present"; else \
		mkdir -p $(AGENT_BIN_DIR); \
		for cmd in worklens-agent worklens-agentctl; do \
			if [ ! -d "agent/cmd/$$cmd" ]; then echo "skipping: agent/cmd/$$cmd/ not yet present"; continue; fi; \
			echo "==> building $$cmd.exe ($(AGENT_GOOS)/$(AGENT_GOARCH), CGO_ENABLED=0)"; \
			( cd agent && CGO_ENABLED=0 GOOS=$(AGENT_GOOS) GOARCH=$(AGENT_GOARCH) \
				go build -trimpath -ldflags "$(AGENT_LDFLAGS)" \
				-o "../$(AGENT_BIN_DIR)/$$cmd.exe" "./cmd/$$cmd" ); \
		done; \
		ls -l $(AGENT_BIN_DIR) 2>/dev/null || true; \
	fi

agent-test: ## Run the Go agent tests with the race detector
	@if [ ! -f agent/go.mod ]; then echo "skipping: agent/ not yet present"; else \
		cd agent && go test ./... -race -count=1; \
	fi

##@ Backend (TypeScript Lambdas)

backend-build: ## Bundle and zip every Lambda listed in backend/functions.json
	@if [ ! -f backend/functions.json ]; then echo "skipping: backend/functions.json not yet present"; else \
		cd backend && npm run --silent build; \
	fi

backend-test: ## Run the backend test suite with coverage
	@if [ ! -f backend/package.json ]; then \
		echo "skipping: backend/ not yet present"; \
	elif [ -z "$$(find backend -name '*.test.ts' -not -path '*/node_modules/*' 2>/dev/null | head -1)" ]; then \
		echo "skipping: no *.test.ts files under backend/ yet"; \
	else \
		cd backend && npx --no-install vitest run --coverage; \
	fi

migrate: ## Apply forward-only SQL migrations via backend/scripts/migrate.ts
	@if [ ! -f backend/scripts/migrate.ts ]; then echo "skipping: backend/scripts/migrate.ts not yet present"; else \
		cd backend && npx --no-install tsx scripts/migrate.ts; \
	fi

##@ Dashboard (Next.js)

dashboard-build: ## Produce a production build of the dashboard
	@if [ ! -f dashboard/package.json ]; then echo "skipping: dashboard/ not yet present"; else \
		cd dashboard && npx --no-install next build; \
	fi

dashboard-test: ## Run the dashboard test suite with coverage
	@if [ ! -f dashboard/package.json ]; then \
		echo "skipping: dashboard/ not yet present"; \
	elif [ -z "$$(find dashboard/test -name '*.test.ts' 2>/dev/null | head -1)" ]; then \
		echo "skipping: no *.test.ts files under dashboard/test/ yet"; \
	else \
		cd dashboard && npx --no-install vitest run --coverage; \
	fi

dashboard-dev: ## Run the dashboard development server on http://localhost:3000
	@if [ ! -f dashboard/package.json ]; then echo "skipping: dashboard/ not yet present"; else \
		cd dashboard && npx --no-install next dev; \
	fi

##@ Infrastructure (Terraform)

tf-fmt: ## Rewrite Terraform files into canonical format
	@if [ ! -d infra ]; then echo "skipping: infra/ not yet present"; else \
		terraform fmt -recursive infra; \
	fi

tf-fmt-check: ## Fail if any Terraform file is not canonically formatted
	@if [ ! -d infra ]; then echo "skipping: infra/ not yet present"; else \
		echo "==> terraform fmt -check -recursive infra"; \
		terraform fmt -check -recursive infra; \
	fi

tf-validate: ## Validate the root stack and the remote-state bootstrap stack
	@for dir in infra infra/bootstrap; do \
		if ! ls "$$dir"/*.tf >/dev/null 2>&1; then echo "skipping: $$dir/ has no Terraform files yet"; continue; fi; \
		echo "==> terraform validate $$dir"; \
		terraform -chdir="$$dir" init -backend=false -input=false -no-color >/dev/null; \
		terraform -chdir="$$dir" validate -no-color; \
	done

tf-plan: ## Plan the root stack into infra/tfplan (uses infra/terraform.tfvars if present)
	@if ! ls infra/*.tf >/dev/null 2>&1; then echo "skipping: infra/ has no Terraform files yet"; else \
		terraform -chdir=infra init -input=false; \
		if [ -f "infra/$(TF_VAR_FILE)" ]; then \
			terraform -chdir=infra plan -input=false -var-file="$(TF_VAR_FILE)" -out=tfplan $(TF_ARGS); \
		else \
			echo "note: infra/$(TF_VAR_FILE) not found — copy infra/terraform.tfvars.example and fill it in"; \
			terraform -chdir=infra plan -input=false -out=tfplan $(TF_ARGS); \
		fi; \
	fi

tf-apply: ## Apply infra/tfplan if it exists, otherwise plan and apply interactively
	@if ! ls infra/*.tf >/dev/null 2>&1; then echo "skipping: infra/ has no Terraform files yet"; else \
		terraform -chdir=infra init -input=false; \
		if [ -f infra/tfplan ]; then \
			terraform -chdir=infra apply -input=false tfplan; \
			rm -f infra/tfplan; \
		elif [ -f "infra/$(TF_VAR_FILE)" ]; then \
			terraform -chdir=infra apply -var-file="$(TF_VAR_FILE)" $(TF_ARGS); \
		else \
			terraform -chdir=infra apply $(TF_ARGS); \
		fi; \
	fi

##@ Environment files

# These read `terraform output` from infra/, so they only work after a successful apply.
# Renaming a Terraform output is therefore a breaking change for these targets.

env-backend: ## Print backend/.env from the Terraform outputs (redirect it yourself)
	@cd infra && terraform output -json > /dev/null 2>&1 || { \
		echo "env-backend: no Terraform state yet — run 'make tf-apply' first." >&2; exit 1; }
	@cd infra && printf '%s\n' \
		"# Generated by 'make env-backend' on $$(date -u +%Y-%m-%dT%H:%M:%SZ)." \
		"# Regenerate rather than hand-editing; see backend/.env.example for what each value means." \
		"AWS_REGION=$$(terraform output -raw api_base_url | sed -E 's#^https://[^.]+\.execute-api\.([^.]+)\..*#\1#')" \
		"DB_HOST=$$(terraform output -raw rds_address)" \
		"DB_PORT=$$(terraform output -raw rds_port)" \
		"DB_NAME=$$(terraform output -raw rds_db_name)" \
		"DB_APP_USER=$$(terraform output -raw rds_app_username)" \
		"DB_MIGRATOR_USER=$$(terraform output -raw rds_master_username)" \
		"DB_PASSWORD=" \
		"DB_SSL_MODE=verify-full" \
		"DB_SSL_CA_PATH=infra/rds-ca-global-bundle.pem" \
		"DB_POOL_MAX=1" \
		"DEVICE_ROOT_KEY_SECRET_ARN=$$(terraform output -raw device_root_key_secret_arn)" \
		"DEVICE_SIGNATURE_WINDOW_SECONDS=300" \
		"S3_SCREENSHOT_BUCKET=$$(terraform output -raw s3_screenshot_bucket)" \
		"S3_SCREENSHOT_KMS_KEY_ID=$$(terraform output -raw s3_kms_key_arn)" \
		"COGNITO_USER_POOL_ID=$$(terraform output -raw cognito_user_pool_id)" \
		"COGNITO_CLIENT_ID=$$(terraform output -raw cognito_client_id)" \
		"LOG_LEVEL=info" \
		"LOG_REQUEST_BODIES=0"

env-dashboard: ## Print dashboard/.env.local from the Terraform outputs (redirect it yourself)
	@cd infra && terraform output -json > /dev/null 2>&1 || { \
		echo "env-dashboard: no Terraform state yet — run 'make tf-apply' first." >&2; exit 1; }
	@cd infra && printf '%s\n' \
		"# Generated by 'make env-dashboard' on $$(date -u +%Y-%m-%dT%H:%M:%SZ)." \
		"NEXT_PUBLIC_API_BASE_URL=$$(terraform output -raw api_base_url)" \
		"NEXT_PUBLIC_COGNITO_USER_POOL_ID=$$(terraform output -raw cognito_user_pool_id)" \
		"NEXT_PUBLIC_COGNITO_CLIENT_ID=$$(terraform output -raw cognito_client_id)" \
		"NEXT_PUBLIC_COGNITO_DOMAIN=$$(terraform output -raw cognito_hosted_ui_domain)" \
		"COGNITO_ISSUER_URL=$$(terraform output -raw cognito_issuer_url)"

##@ Compliance gates

check-privacy: ## Fail if any source file references a forbidden capture API
	@./scripts/check-privacy.sh

check-iam: ## Fail on IAM Resource "*" without a justifying annotation
	@./scripts/check-iam.sh

check-readme: ## Fail if the README's Responsible & Lawful Use section is missing or thin
	@./scripts/check-readme.sh

check-functions: ## Fail if backend/functions.json and the Terraform catalogue disagree
	@./scripts/check-functions.sh

check-migrations: ## Fail if a migration file is not bundled into the db-migrate Lambda
	@./scripts/check-migrations.sh

check-routes: ## Fail if the dashboard calls an endpoint the backend does not serve
	@./scripts/check-routes.sh

.PHONY: env-backend env-dashboard help bootstrap fmt lint test build ci clean \
	agent-windows agent-test \
	backend-build backend-test migrate \
	dashboard-build dashboard-test dashboard-dev \
	tf-fmt tf-fmt-check tf-validate tf-plan tf-apply \
	check-privacy check-iam check-readme check-functions check-migrations check-routes
