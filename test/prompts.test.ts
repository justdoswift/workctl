import { describe, expect, it } from "vitest";

import {
  filterJarCandidateChoices,
  filterTargetChoices,
  formatTargetChoice,
  preferredNamespace
} from "../src/prompts.js";
import type { JarCandidate } from "../src/dependencies.js";
import type { KubeTarget } from "../src/types.js";

describe("prompts", () => {
  it("prefers tax-digital when it is available", () => {
    expect(preferredNamespace(["default", "tax-digital", "kubesphere-system"])).toBe("tax-digital");
  });

  it("falls back to the first namespace when tax-digital is unavailable", () => {
    expect(preferredNamespace(["default", "kubesphere-system"])).toBe("default");
  });

  it("shows deployment replica counts in target choices", () => {
    expect(
      formatTargetChoice({
        kind: "Deployment",
        name: "tax-data-extraction-server",
        namespace: "tax-digital",
        selector: { app: "tax-data-extraction-server" },
        desiredReplicas: 0,
        readyReplicas: 0
      })
    ).toBe("tax-data-extraction-server  工作负载(Deployment)  (0/0)");
  });

  it("shows ready deployment replica counts in target choices", () => {
    expect(
      formatTargetChoice({
        kind: "Deployment",
        name: "tax-invoice-business-server",
        namespace: "tax-digital",
        selector: { app: "tax-invoice-business-server" },
        desiredReplicas: 1,
        readyReplicas: 1
      })
    ).toBe("tax-invoice-business-server  工作负载(Deployment)  (1/1)");
  });

  it("filters workload choices by search term", () => {
    const targets: KubeTarget[] = [
      target("tax-invoice-business-server"),
      target("tax-api-proxy-server"),
      target("redis")
    ];

    expect(filterTargetChoices(targets, "").map((choice) => choice.value.name)).toEqual([
      "tax-invoice-business-server",
      "tax-api-proxy-server",
      "redis"
    ]);
    expect(filterTargetChoices(targets, "invoice").map((choice) => choice.value.name)).toEqual([
      "tax-invoice-business-server"
    ]);
  });

  it("filters jar candidate choices by search term", () => {
    const candidates: JarCandidate[] = [
      { source: "process", path: "/app/tax-invoice-business-server.jar" },
      { source: "scan", path: "/opt/helper.jar" }
    ];

    expect(filterJarCandidateChoices(candidates, "invoice")).toEqual([
      {
        name: "/app/tax-invoice-business-server.jar  Java 进程",
        value: "/app/tax-invoice-business-server.jar"
      }
    ]);
  });
});

function target(name: string): KubeTarget {
  return {
    kind: "Deployment",
    name,
    namespace: "tax-digital",
    selector: {},
    desiredReplicas: 1,
    readyReplicas: 1
  };
}
