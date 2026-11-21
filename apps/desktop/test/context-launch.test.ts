import { describe, expect, it } from "vitest";
import { isEmptyRequest, parseLaunchArgs, recogniseSentence } from "../src/main/contexts/launch.ts";

describe("launching with a path", () => {
  const electron = ["/usr/bin/electron", "/app/out/main/index.js"];

  it("takes folders after the app path of a dev launch, from the folder the launch was in", () => {
    const r = parseLaunchArgs(
      [...electron, "--no-sandbox", "../longplay", "/abs/x", "~/code/y"],
      "/work/draft",
      {
        defaultApp: true,
        home: "/home/niko",
      },
    );
    expect(r).toEqual({
      folders: ["/work/longplay", "/abs/x", "/home/niko/code/y"],
      imports: [],
    });
  });

  it("takes folders straight after the program of a packaged launch", () => {
    const r = parseLaunchArgs(["/Applications/draft", "/code/longplay", "/code/longplay"], "/", {});
    expect(r.folders).toEqual(["/code/longplay"]);
  });

  it("reads --import in both forms and leaves Chromium's flags alone", () => {
    const r = parseLaunchArgs(
      [
        ...electron,
        "--remote-debugging-port=0",
        "--import",
        "/old/data",
        "--import=/older",
        "--",
        "/p",
      ],
      "/",
      { defaultApp: true },
    );
    expect(r).toEqual({ folders: ["/p"], imports: ["/old/data", "/older"] });
    expect(isEmptyRequest(parseLaunchArgs(electron, "/", { defaultApp: true }))).toBe(true);
  });
});

describe("sentences that open a context", () => {
  const names = ["local", "longplay"];

  it("opens a context that exists, and leaves everything else to the agent", () => {
    expect(recogniseSentence("open longplay", names)).toEqual({ kind: "open", name: "longplay" });
    expect(recogniseSentence("Please open the context LongPlay.", names)).toEqual({
      kind: "open",
      name: "longplay",
    });
    expect(recogniseSentence("open sesame", names)).toBeNull();
    expect(recogniseSentence("open longplay and tell me what changed", names)).toBeNull();
    expect(recogniseSentence("what is open?", names)).toBeNull();
  });

  it("makes a context for a folder", () => {
    expect(recogniseSentence("new context for ~/code/x", names)).toEqual({
      kind: "new",
      folder: "~/code/x",
    });
    expect(recogniseSentence('create a new context in "/Users/me/my code"', names)).toEqual({
      kind: "new",
      folder: "/Users/me/my code",
    });
    expect(recogniseSentence("new context for the build system", names)).toBeNull();
  });
});
