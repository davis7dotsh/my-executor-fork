import { expect, it } from "@effect/vitest";
import { Effect, Exit, Fiber } from "effect";
import { createServer } from "node:http";
import { wellKnownSkillsEffect } from "../src/implementation/skills.ts";
import { skillLoadLimits } from "../src/contracts/skills.ts";

/** An actual first-party skill publication; held HTTP bodies expose reader concurrency. */
const publication = (skills: number, filesPerSkill: number) =>
  Effect.gen(function* () {
    const documents = new Map<string, string>();
    const index = Array.from({ length: skills }, (_, i) => {
      const name = `skill-${i}`;
      const files = [
        "SKILL.md",
        ...Array.from({ length: filesPerSkill - 1 }, (_, j) => `file-${j}.md`),
      ];
      for (const file of files)
        documents.set(
          `/.well-known/agent-skills/${name}/${file}`,
          file === "SKILL.md"
            ? `---\nname: ${name}\ndescription: Synthetic instructions.\n---\n# ${name}`
            : `Reference ${file}`,
        );
      return { name, files };
    });
    let active = 0;
    let peak = 0;
    let blocked = true;
    let waveStarted: () => void = () => {};
    let overflowStarted: () => void = () => {};
    const wave = new Promise<void>((resolve) => {
      waveStarted = resolve;
    });
    const overflow = new Promise<void>((resolve) => {
      overflowStarted = resolve;
    });
    const held: Array<() => void> = [];
    const release = () => {
      blocked = false;
      held.splice(0).forEach((respond) => respond());
    };
    const server = createServer((request, response) => {
      if (request.url === "/.well-known/agent-skills/index.json") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ skills: index }));
        return;
      }
      const document = documents.get(request.url ?? "");
      if (document === undefined) {
        response.writeHead(404).end();
        return;
      }
      active += 1;
      peak = Math.max(peak, active);
      if (active >= skillLoadLimits.concurrency) waveStarted();
      if (active > skillLoadLimits.concurrency) overflowStarted();
      response.once("close", () => {
        active -= 1;
      });
      const respond = () => {
        response.end(document);
      };
      if (blocked) held.push(respond);
      else respond();
    });
    yield* Effect.acquireRelease(
      Effect.promise(() => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))),
      () =>
        Effect.promise(
          () =>
            new Promise<void>((resolve, reject) => {
              release();
              server.closeAllConnections();
              server.close((error) => (error ? reject(error) : resolve()));
            }),
        ),
    );
    const address = server.address();
    if (address === null || typeof address === "string")
      return yield* Effect.die("Missing publication port");
    return {
      url: `http://127.0.0.1:${address.port}`,
      wave: Effect.promise(() => wave),
      overflow: Effect.promise(() => overflow),
      release: Effect.sync(release),
      peak: () => peak,
    };
  });

it.live(
  "separate one-file skill folders load together and retain publication order",
  () =>
    Effect.gen(function* () {
      const publisher = yield* publication(16, 1);
      const read = yield* wellKnownSkillsEffect({ url: publisher.url }).pipe(Effect.forkScoped);
      const wave = yield* Effect.exit(publisher.wave.pipe(Effect.timeout("500 millis")));
      expect(
        Exit.isSuccess(wave),
        "eight independent folders should start before the first file finishes",
      ).toBe(true);
      expect(publisher.peak()).toBe(skillLoadLimits.concurrency);
      yield* publisher.release;
      const skills = yield* Fiber.join(read);
      expect(skills.map((skill) => skill.name)).toEqual(
        Array.from({ length: 16 }, (_, i) => `skill-${i}`),
      );
    }).pipe(Effect.scoped),
  10_000,
);

it.live(
  "nested folders share one request limit across their files",
  () =>
    Effect.gen(function* () {
      const publisher = yield* publication(4, 4);
      const read = yield* wellKnownSkillsEffect({ url: publisher.url }).pipe(Effect.forkScoped);
      yield* publisher.wave.pipe(Effect.timeout("500 millis"));
      const overflow = yield* Effect.exit(publisher.overflow.pipe(Effect.timeout("100 millis")));
      expect(
        Exit.isFailure(overflow),
        "nested file readers must share the eight-request limit",
      ).toBe(true);
      yield* publisher.release;
      expect(yield* Fiber.join(read)).toHaveLength(4);
      expect(publisher.peak()).toBeLessThanOrEqual(skillLoadLimits.concurrency);
    }).pipe(Effect.scoped),
  10_000,
);
