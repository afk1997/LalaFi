# xpool local environment. Run from infra/: `make up`, `make logs S=relayer`, `make down`.
COMPOSE := docker compose -f docker-compose.yml
ROOT    := $(abspath ..)

.PHONY: up down logs ps e2e deps fail-next status

## Host deps: Solidity libraries resolve from node_modules (contracts/remappings.txt).
deps:
	@test -d $(ROOT)/node_modules || (cd $(ROOT) && pnpm install)
	@mkdir -p $(ROOT)/deployments

## Start anvils → deploy → mock-bridge, 4 validators, relayer, finalizer, keeper.
up: deps
	$(COMPOSE) up -d --build
	$(COMPOSE) ps

## Stop everything and delete all chain + service state (fresh chains next time).
down:
	$(COMPOSE) down -v --remove-orphans

## Follow logs (all services, or one: make logs S=validator-1).
logs:
	$(COMPOSE) logs -f --tail=200 $(S)

ps:
	$(COMPOSE) ps

## Full local scenario matrix (PRD 15.4): real proofs, relayer, validators, mock bridges.
e2e:
	@if [ -x $(ROOT)/scripts/e2e.sh ]; then $(ROOT)/scripts/e2e.sh; \
	else echo "scripts/e2e.sh not present yet (TODO(xpool): add after merge)"; exit 1; fi

## Failure injection: make fail-next ROUTE=arb-l1-to-l2 N=1
fail-next:
	curl -fsS -X POST -H 'content-type: application/json' \
	  -d '{"route":"$(ROUTE)","count":$(or $(N),1)}' http://127.0.0.1:8090/admin/fail-next; echo

status:
	curl -fsS http://127.0.0.1:8090/admin/status; echo
