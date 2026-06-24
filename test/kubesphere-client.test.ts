import { describe, expect, it } from "vitest";

import {
  deploymentReplicaSetNames,
  podBelongsToDeployment
} from "../src/kubesphere-client.js";

describe("kubesphere client helpers", () => {
  it("matches pods to deployments through replica set owner references", () => {
    const replicaSetNames = deploymentReplicaSetNames(
      [
        {
          metadata: {
            name: "tax-data-extraction-server-745b969b5d",
            ownerReferences: [{ kind: "Deployment", name: "tax-data-extraction-server" }]
          }
        },
        {
          metadata: {
            name: "other-server-745b969b5d",
            ownerReferences: [{ kind: "Deployment", name: "other-server" }]
          }
        }
      ],
      "tax-data-extraction-server"
    );

    expect(replicaSetNames).toEqual(new Set(["tax-data-extraction-server-745b969b5d"]));
    expect(
      podBelongsToDeployment(
        {
          metadata: {
            name: "tax-data-extraction-server-745b969b5d-l8pvg",
            ownerReferences: [{ kind: "ReplicaSet", name: "tax-data-extraction-server-745b969b5d" }]
          }
        },
        "tax-data-extraction-server",
        replicaSetNames
      )
    ).toBe(true);
    expect(
      podBelongsToDeployment(
        {
          metadata: {
            name: "other-server-745b969b5d-l8pvg",
            ownerReferences: [{ kind: "ReplicaSet", name: "other-server-745b969b5d" }]
          }
        },
        "tax-data-extraction-server",
        replicaSetNames
      )
    ).toBe(false);
  });
});
