"use strict";

const { runStageEvaluationProbe } = require("./sandbox-stage-probe");

try {
    const result = runStageEvaluationProbe();
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== "passed") process.exitCode = 1;
} catch (error) {
    const diagnostic = typeof error.cause?.stderr === "string"
        ? error.cause.stderr.slice(0, 512)
        : undefined;
    console.error(JSON.stringify({
        status: "failed",
        reasonCode: error.code || "unexpected-error",
        cleanupError: error.cleanupError || null,
        ...(diagnostic ? { diagnostic } : {})
    }));
    process.exitCode = 1;
}
