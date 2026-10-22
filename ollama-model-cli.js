const { getServiceBaseUrl, requestJson } = require("./improvement-advisor");

const serviceRequestTimeoutMs = 30000;
const validSkills = new Set(["coding", "thinking"]);
const validSizes = new Set(["small", "medium", "large"]);
const ratingFields = new Set(["coding", "thinking", "small", "medium", "large"]);

function parseModelArgs(args) {
    const command = args[0] || "list";
    if (!["list", "rank", "rate"].includes(command)) {
        throw new Error("Usage: npm run models -- list|rank [--skill coding|thinking] [--size small|medium|large] | rate <model> [--coding 1-5] [--thinking 1-5] [--small 1-5] [--medium 1-5] [--large 1-5]");
    }

    let skill = "coding";
    let size = "medium";
    let model;
    const ratings = {};
    for (let index = 1; index < args.length; index += 1) {
        const argument = args[index];
        if (command === "rate" && !argument.startsWith("--") && model === undefined) {
            model = argument;
            continue;
        }
        if (!argument.startsWith("--") || !args[index + 1]) {
            throw new Error(`Unexpected argument: ${argument}`);
        }
        const option = argument.slice(2);
        const value = args[++index];
        if (command !== "rate" && option === "skill") {
            skill = value;
        } else if (command !== "rate" && option === "size") {
            size = value;
        } else if (command === "rate" && ratingFields.has(option)) {
            const score = Number(value);
            if (!Number.isInteger(score) || score < 1 || score > 5) {
                throw new Error(`--${option} must be an integer from 1 to 5.`);
            }
            ratings[option] = score;
        } else {
            throw new Error(`Unknown option: ${argument}`);
        }
    }

    if (command === "rate" && (!model || Object.keys(ratings).length === 0)) {
        throw new Error("Rate requires an installed model tag and at least one 1-5 preference.");
    }
    if (command !== "rate" && (!validSkills.has(skill) || !validSizes.has(size))) {
        throw new Error("Rank filters must use coding/thinking and small/medium/large.");
    }
    return { command, skill, size, model, ratings };
}

async function main(args, options = {}) {
    const parsed = parseModelArgs(args);
    const fetchImpl = options.fetchImpl || fetch;
    const baseUrl = getServiceBaseUrl(options.serviceUrl);
    if (parsed.command === "rate") {
        const result = await requestJson(fetchImpl, `${baseUrl}/ollama/models/preferences`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: parsed.model, ...parsed.ratings })
        }, options.requestTimeoutMs || serviceRequestTimeoutMs);
        console.log(`Saved ${parsed.model}: ${Object.entries(result.preference)
            .map(([field, score]) => `${field}=${score}`).join(" ")}`);
        return result;
    }

    const query = new URLSearchParams({ skill: parsed.skill, size: parsed.size });
    const result = await requestJson(fetchImpl, `${baseUrl}/ollama/models?${query}`, {},
        options.requestTimeoutMs || serviceRequestTimeoutMs);
    console.log(`Ollama models ranked for ${result.skill}, ${result.size} request`);
    console.log(`Configured default: ${result.configuredDefault}`);
    for (const model of result.catalog.filter(item => item.selectable === false)) {
        console.log(`Excluded from chat ranking: ${model.name} (not chat-capable)`);
    }
    for (const model of result.models) {
        console.log(`${model.rank}. ${model.name} score=${model.score} ` +
            `task=${model.preference[parsed.skill]} size=${model.preference[parsed.size]} ` +
            `feedback=${model.feedbackCount} active=${model.activeJobs} completed=${model.completedJobs}`);
    }
    return result;
}

if (require.main === module) {
    main(process.argv.slice(2), { serviceUrl: process.env.OFFLOADING_AGENT_URL }).catch(error => {
        console.error(error.message);
        process.exitCode = 1;
    });
}

module.exports = { main, parseModelArgs };
