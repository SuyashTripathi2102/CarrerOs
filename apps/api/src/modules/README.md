Each domain module lives in its own folder here (e.g. `auth/`, `resumes/`, `jobs/`, `companies/`,
`matching/`, `notifications/`, `admin/`). A module is added when its phase starts — see
`/ARCHITECTURE.md` for the phase order.

Convention per module (Clean Architecture layering):

```
modules/<name>/
  <name>.module.ts        # wires providers, imports, exports
  <name>.controller.ts    # HTTP layer — request/response, DTOs, no business logic
  <name>.service.ts       # application/business logic
  <name>.repository.ts    # data access — the only place that talks to PrismaService
  dto/                    # class-validator request/response DTOs
  entities/               # domain types independent of the Prisma schema shape
```

Controllers depend on services; services depend on repository interfaces, not on Prisma directly.
This keeps business logic testable without a database and lets the persistence layer change
without touching application logic.
