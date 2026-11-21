import 'reflect-metadata';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { RequestMethod } from '@nestjs/common';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants';
import { IS_PUBLIC_KEY } from './decorators/public.decorator';
import { ROLES_KEY } from './decorators/roles.decorator';

/**
 * Every route of the API, classified, and checked against what its decorators really say (W8).
 *
 * A route added without a class here fails this test, so nobody can add an operator route and
 * forget its role. A class is a claim the test verifies:
 *   public     no sign-in (@Public), and no internal token
 *   internal   @Public plus InternalTokenGuard: the workers and the scraper only
 *   admin      @Roles(ADMIN); RolesGuard checks the role in the database
 *   catalogue  a read (GET) of the shared catalogue, open to every signed-in account
 *   own        the signed-in account's own data. @CurrentUser is required, but it does not prove
 *              ownership on its own: a route that takes a resource id must carry the evidence
 *              that its service looks the resource up with the user's id (the fourth field),
 *              and no route may take a user id from the path.
 */
type Class = 'public' | 'internal' | 'admin' | 'catalogue' | 'own';
const ROUTES: [method: string, path: string, cls: Class, ownership?: string][] =
  [
    ['GET', '/admin/health', 'admin'],
    ['GET', '/ai/usage', 'admin'],
    ['POST', '/companies', 'admin'],
    ['POST', '/crawl/discover', 'admin'],
    ['GET', '/crawl/runs', 'admin'],
    ['POST', '/crawl/seed', 'admin'],
    ['POST', '/crawl/trigger', 'admin'],
    ['GET', '/discovery/coverage', 'admin'],
    ['GET', '/discovery/crawl-schedule', 'admin'],
    ['GET', '/discovery/extraction', 'admin'],
    ['GET', '/discovery/pipeline', 'admin'],
    ['GET', '/discovery/render', 'admin'],
    ['GET', '/discovery/replay', 'admin'],
    ['GET', '/discovery/stats', 'admin'],
    ['POST', '/intelligence/derive', 'admin'],
    ['GET', '/source-trust', 'admin'],
    ['GET', '/companies', 'catalogue'],
    ['GET', '/companies/:id', 'catalogue'],
    ['GET', '/companies/:id/intelligence', 'catalogue'],
    ['GET', '/dashboard/sources', 'catalogue'],
    ['GET', '/intelligence/top-growing', 'catalogue'],
    ['GET', '/jobs', 'catalogue'],
    ['GET', '/jobs/:id', 'catalogue'],
    ['GET', '/watchlist/search', 'catalogue'],
    ['POST', '/internal/ats-conflicts/resolve', 'internal'],
    ['POST', '/internal/boards/failed', 'internal'],
    ['POST', '/internal/boards/ingest', 'internal'],
    ['POST', '/internal/companies/:id/jobs/sync', 'internal'],
    ['GET', '/internal/companies/due', 'internal'],
    ['POST', '/internal/company-identity/backfill-tokens', 'internal'],
    ['POST', '/internal/company-identity/resolve', 'internal'],
    ['GET', '/internal/company-identity/review', 'internal'],
    ['POST', '/internal/daily-brief', 'internal'],
    ['POST', '/internal/daily-brief/consider-digest', 'internal'],
    ['POST', '/internal/discovery/:companyId/result', 'internal'],
    ['POST', '/internal/discovery/bulk', 'internal'],
    ['GET', '/internal/discovery/career-pages/due', 'internal'],
    ['GET', '/internal/discovery/due', 'internal'],
    ['POST', '/internal/discovery/extraction-run', 'internal'],
    ['POST', '/internal/discovery/flag-render', 'internal'],
    ['GET', '/internal/discovery/render/due', 'internal'],
    ['POST', '/internal/discovery/snapshot', 'internal'],
    ['GET', '/internal/discovery/snapshots/replay-due', 'internal'],
    ['POST', '/internal/embeddings/reconcile', 'internal'],
    ['POST', '/internal/intelligence/derive-signals', 'internal'],
    ['GET', '/internal/jobs/hydration-due', 'internal'],
    ['POST', '/internal/jobs/repair-descriptions', 'internal'],
    ['POST', '/internal/matches/reconcile', 'internal'],
    ['POST', '/internal/matches/rescore', 'internal'],
    ['POST', '/internal/source-trust/recompute', 'internal'],
    ['GET', '/analytics/quality', 'own'],
    ['GET', '/analytics/signals', 'own'],
    ['GET', '/analytics/sources', 'own'],
    ['GET', '/applications', 'own'],
    ['POST', '/applications', 'own'],
    [
      'PATCH',
      '/applications/:id',
      'own',
      'transition(user.id, id): app.userId !== userId -> 404',
    ],
    ['GET', '/applications/intelligence', 'own'],
    ['GET', '/applications/stats', 'own'],
    ['POST', '/auth/change-password', 'own'],
    ['GET', '/auth/me', 'own'],
    ['GET', '/dashboard', 'own'],
    ['GET', '/dashboard/pipeline', 'own'],
    ['GET', '/dashboard/supply', 'own'],
    ['POST', '/events', 'own'],
    ['POST', '/events/impressions', 'own'],
    ['GET', '/excluded', 'own'],
    ['GET', '/matches', 'own'],
    ['GET', '/matches/browse', 'own'],
    ['POST', '/matches/career-preference', 'own'],
    [
      'GET',
      '/matches/detail/:jobId',
      'own',
      'jobDetail(user.id, jobId): { userId, jobId, resumeVersionId }',
    ],
    ['POST', '/matches/generate', 'own'],
    ['POST', '/matches/reconcile', 'own'],
    ['POST', '/matches/rescore', 'own'],
    [
      'GET',
      '/matches/why/:jobId',
      'own',
      'explainNotification(user.id, jobId): { userId, jobId }',
    ],
    ['GET', '/needs-review', 'own'],
    [
      'POST',
      '/needs-review/:jobId',
      'own',
      'review(user.id, jobId): { userId, jobId }',
    ],
    ['GET', '/notifications', 'own'],
    [
      'PATCH',
      '/notifications/:id/read',
      'own',
      'updateMany { id, userId: user.id }',
    ],
    [
      'POST',
      '/referrals/:id/draft',
      'own',
      'generateDraft(user.id, id): { id: contactId, userId }',
    ],
    [
      'POST',
      '/referrals/:id/followup',
      'own',
      'generateFollowUp(user.id, id): { id: contactId, userId }',
    ],
    [
      'POST',
      '/referrals/:id/followup/logged',
      'own',
      'logFollowUp(user.id, id): { id: contactId, userId }',
    ],
    [
      'PATCH',
      '/referrals/:id/status',
      'own',
      'setStatus(user.id, id, status): { id: contactId, userId }',
    ],
    [
      'GET',
      '/referrals/job/:jobId',
      'own',
      'forJob(user.id, jobId): { userId, companyName }',
    ],
    ['GET', '/referrals/outreach', 'own'],
    ['GET', '/resumes', 'own'],
    ['POST', '/resumes', 'own'],
    [
      'DELETE',
      '/resumes/:id',
      'own',
      'delete(user.id, id) -> get() -> findByIdForUser { id, userId }',
    ],
    [
      'GET',
      '/resumes/:id',
      'own',
      'get(user.id, id) -> findByIdForUser { id, userId }',
    ],
    ['DELETE', '/resumes/master', 'own'],
    ['GET', '/resumes/master', 'own'],
    ['PUT', '/resumes/master', 'own'],
    [
      'GET',
      '/resumes/tailor/:jobId',
      'own',
      "tailorResume(user.id, jobId): the user's own primary resume { userId, isPrimary }",
    ],
    [
      'POST',
      '/resumes/versions/:versionId/activate',
      'own',
      'activate(user.id, id): { resume: { userId } }',
    ],
    [
      'POST',
      '/resumes/versions/:versionId/parse',
      'own',
      'enqueueParse(user.id, id): the version must be one of findAllForUser(userId)',
    ],
    [
      'GET',
      '/resumes/versions/:versionId/profile',
      'own',
      'ownedVersion(userId, id): { id, resume: { userId } }',
    ],
    [
      'PUT',
      '/resumes/versions/:versionId/profile',
      'own',
      'ownedVersion(userId, id): { id, resume: { userId } }',
    ],
    [
      'GET',
      '/resumes/versions/:versionId/reconcile',
      'own',
      'ownedVersion(userId, id): { id, resume: { userId } }',
    ],
    [
      'POST',
      '/resumes/versions/:versionId/reconcile',
      'own',
      'ownedVersion(userId, id): { id, resume: { userId } }',
    ],
    ['GET', '/today', 'own'],
    ['GET', '/users/me', 'own'],
    ['GET', '/users/me/preferences', 'own'],
    ['PUT', '/users/me/preferences', 'own'],
    ['GET', '/watchlist', 'own'],
    ['POST', '/watchlist', 'own'],
    ['DELETE', '/watchlist/:id', 'own', 'remove(user.id, id): { id, userId }'],
    ['GET', '/', 'public'],
    ['POST', '/auth/login', 'public'],
    ['POST', '/auth/logout', 'public'],
    ['POST', '/auth/refresh', 'public'],
    ['POST', '/auth/register', 'public'],
    ['GET', '/health', 'public'],
    ['POST', '/telegram/webhook', 'public'],
  ];

/**
 * Routes that other workstreams add and that may not be integrated yet: absent from a tree without
 * them, and checked like every other route when present. Every route that exists must be classified.
 */
const ELSEWHERE = new Map([
  ['POST /internal/boards/failed', 'W5 (board-outage recording)'],
]);

interface Found {
  method: string;
  path: string;
  isPublic: boolean;
  guards: string[];
  roles: string[];
  currentUser: boolean;
}

function controllerFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return controllerFiles(path);
    return path.endsWith('.controller.ts') ? [path] : [];
  });
}

/** Every route Nest would mount, read from the same metadata Nest uses. */
function routes(): Found[] {
  const found: Found[] = [];
  for (const file of controllerFiles(join(__dirname, '..'))) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const exported = require(file) as Record<string, unknown>;
    for (const value of Object.values(exported)) {
      if (
        typeof value !== 'function' ||
        Reflect.getMetadata(PATH_METADATA, value) === undefined
      )
        continue;
      const controller = value as new (...args: unknown[]) => object;
      const base = String(Reflect.getMetadata(PATH_METADATA, controller) ?? '');
      const classGuards = (Reflect.getMetadata(GUARDS_METADATA, controller) ??
        []) as { name: string }[];
      for (const key of Object.getOwnPropertyNames(controller.prototype)) {
        const handler = (controller.prototype as Record<string, unknown>)[key];
        if (
          typeof handler !== 'function' ||
          Reflect.getMetadata(METHOD_METADATA, handler) === undefined
        )
          continue;
        const sub = String(Reflect.getMetadata(PATH_METADATA, handler) ?? '');
        const guards = [
          ...classGuards,
          ...((Reflect.getMetadata(GUARDS_METADATA, handler) ?? []) as {
            name: string;
          }[]),
        ];
        const args = Object.keys(
          (Reflect.getMetadata(ROUTE_ARGS_METADATA, controller, key) ??
            {}) as object,
        );
        found.push({
          method:
            RequestMethod[
              Reflect.getMetadata(METHOD_METADATA, handler) as number
            ],
          path: (
            '/' + [base, sub].filter((p) => p && p !== '/').join('/')
          ).replace(/\/+/g, '/'),
          isPublic:
            Reflect.getMetadata(IS_PUBLIC_KEY, controller) === true ||
            Reflect.getMetadata(IS_PUBLIC_KEY, handler) === true,
          guards: guards.map((g) => g.name),
          roles: (Reflect.getMetadata(ROLES_KEY, handler) ??
            Reflect.getMetadata(ROLES_KEY, controller) ??
            []) as string[],
          currentUser: args.some((a) => a.includes('__customRouteArgs__')),
        });
      }
    }
  }
  return found;
}

describe('route inventory (W8)', () => {
  const found = routes();
  const key = (method: string, path: string) => `${method} ${path}`;
  const declared = new Map(
    ROUTES.map(([m, p, c, o]) => [key(m, p), { cls: c, ownership: o }]),
  );

  it('finds every route of the API once: 112, or 111 without W5', () => {
    const present =
      ROUTES.length -
      [...ELSEWHERE.keys()].filter(
        (k) => !found.some((r) => key(r.method, r.path) === k),
      ).length;
    expect(found).toHaveLength(present);
    expect(new Set(found.map((r) => key(r.method, r.path))).size).toBe(
      found.length,
    );
  });

  it('has a class for every route, and no class for a route that does not exist', () => {
    const unclassified = found
      .map((r) => key(r.method, r.path))
      .filter((k) => !declared.has(k));
    const stale = [...declared.keys()].filter(
      (k) =>
        !ELSEWHERE.has(k) && !found.some((r) => key(r.method, r.path) === k),
    );
    expect({ unclassified, stale }).toEqual({ unclassified: [], stale: [] });
  });

  it('counts 7 public, 26 internal, 16 admin, 8 catalogue and 55 own routes', () => {
    const counts: Record<string, number> = {};
    for (const [, , cls] of ROUTES) counts[cls] = (counts[cls] ?? 0) + 1;
    expect(counts).toEqual({
      public: 7,
      internal: 26,
      admin: 16,
      catalogue: 8,
      own: 55,
    });
  });

  it.each(ROUTES.map(([m, p, c, o]) => [`${m} ${p}`, c, o] as const))(
    '%s is %s, as its decorators say',
    (route, cls, ownership) => {
      const r = found.find((f) => key(f.method, f.path) === route);
      if (!r && ELSEWHERE.has(route)) return; // not in this tree yet; checked once it is
      expect(r).toBeDefined();
      if (!r) return;
      const internalGuard = r.guards.includes('InternalTokenGuard');
      const violations: string[] = [];
      if (cls === 'public' && (!r.isPublic || internalGuard))
        violations.push(
          'a public route must be @Public without the internal token',
        );
      if (cls === 'internal' && !(r.isPublic && internalGuard))
        violations.push(
          'an internal route needs @Public and InternalTokenGuard',
        );
      if (cls !== 'public' && cls !== 'internal' && r.isPublic)
        violations.push('only public and internal routes may be @Public');
      if (cls === 'admin' && !(r.roles.length === 1 && r.roles[0] === 'ADMIN'))
        violations.push('an admin route needs @Roles(ADMIN)');
      if (cls !== 'admin' && r.roles.length > 0)
        violations.push('only admin routes carry @Roles');
      if (cls === 'catalogue' && r.method !== 'GET')
        violations.push('a catalogue route must be a read (GET)');
      if (cls === 'own') {
        if (!r.currentUser)
          violations.push('an own-data route needs @CurrentUser');
        if (/:user(Id)?\b/i.test(r.path))
          violations.push(
            'an own-data route may not take a user id from the path',
          );
        if (r.path.includes(':') && !ownership)
          violations.push(
            'an own-data route with a resource id needs its ownership evidence',
          );
      }
      expect(violations).toEqual([]);
    },
  );
});
