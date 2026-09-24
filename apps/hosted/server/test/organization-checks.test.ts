import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Layer } from "effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http";
import {
  ApiAuthentication,
  Authentication,
  AuthenticationUnavailable,
  Principal,
  Unauthorized,
} from "../src/contracts/auth.ts";
import {
  CurrentOrganization,
  OrganizationId,
  type OrganizationRole,
} from "../src/contracts/organization.ts";
import { OrganizationTombstones } from "../src/contracts/organization-removal.ts";
import { withOrganizationRequest } from "../src/implementation/organization.ts";

const principal = Principal.make({
  userId: Principal.fields.userId.make("synthetic-user"),
  sessionId: Principal.fields.sessionId.make("synthetic-session"),
  name: "Fixture",
});
const makeHandler = (
  membership: Effect.Effect<
    { readonly role: typeof OrganizationRole.Type },
    AuthenticationUnavailable
  >,
  removed: Effect.Effect<boolean>,
  current = Effect.succeed<Principal | null>(principal),
) =>
  Effect.gen(function* () {
    const auth = Layer.succeed(Authentication, {
      origin: "https://organization.example.test",
      current: () => current,
      organization: () => Effect.succeed(OrganizationId.make("synthetic-organization")),
      organizationSlug: () => Effect.succeed("fixture"),
      membership: () => membership,
      removeOrganization: () => Effect.die("This fixture does not remove organizations"),
    });
    const route = withOrganizationRequest(() =>
      Effect.map(CurrentOrganization, ({ role }) => HttpServerResponse.text(role)),
    ).pipe(
      Effect.catchTags({
        Unauthorized: () => Effect.succeed(HttpServerResponse.empty({ status: 401 })),
        OrganizationForbidden: () => Effect.succeed(HttpServerResponse.empty({ status: 403 })),
        AuthenticationUnavailable: () => Effect.succeed(HttpServerResponse.empty({ status: 503 })),
      }),
    );
    const router = HttpRouter.add("GET", "/org/:organization", route).pipe(
      HttpRouter.provideRequest(
        Layer.mergeAll(
          auth,
          Layer.succeed(ApiAuthentication, {
            origin: "https://organization.example.test",
            authenticate: () => Effect.fail(new Unauthorized()),
          }),
          Layer.succeed(OrganizationTombstones, () => removed),
        ),
      ),
      Layer.provide(HttpServer.layerServices),
    );
    const server = yield* Effect.acquireRelease(
      Effect.sync(() => HttpRouter.toWebHandler(router, { disableLogger: true })),
      (server) => Effect.promise(() => server.dispose()),
    );
    const controller = new AbortController();
    return Effect.promise(() =>
      server.handler(
        new Request("https://organization.example.test/org/fixture", { signal: controller.signal }),
      ),
    ).pipe(Effect.ensuring(Effect.sync(() => controller.abort())));
  });

it.live("membership and removal start together after verifying the session", () =>
  Effect.gen(function* () {
    const membershipStarted = yield* Deferred.make<void>();
    const removalStarted = yield* Deferred.make<void>();
    const membership = Deferred.succeed(membershipStarted, undefined).pipe(
      Effect.andThen(Deferred.await(removalStarted)),
      Effect.as({ role: "member" as const }),
    );
    const removed = Deferred.succeed(removalStarted, undefined).pipe(
      Effect.andThen(Deferred.await(membershipStarted)),
      Effect.as(false),
    );
    const request = yield* makeHandler(membership, removed);
    const response = yield* request.pipe(Effect.timeout("1 second"));
    expect(response.status).toBe(200);
    expect(yield* Effect.promise(() => response.text())).toBe("member");
  }),
);

it.live("a tombstone still dominates an earlier membership failure", () =>
  Effect.gen(function* () {
    const request = yield* makeHandler(
      Effect.fail(new AuthenticationUnavailable()),
      Effect.succeed(true),
    );
    expect((yield* request).status).toBe(403);
  }),
);

it.live("an invalid session starts neither organization check", () =>
  Effect.gen(function* () {
    const request = yield* makeHandler(
      Effect.die("An invalid session must not read membership"),
      Effect.die("An invalid session must not read tombstones"),
      Effect.succeed(null),
    );
    expect((yield* request).status).toBe(401);
  }),
);
