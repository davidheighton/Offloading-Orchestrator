const preferenceFields = ["coding", "thinking", "small", "medium", "large"];
const skills = new Set(["coding", "thinking"]);
const sizes = new Set(["small", "medium", "large"]);

function isChatModel(model) {
    if (Array.isArray(model.capabilities)) {
        return model.capabilities.includes("completion") || model.capabilities.includes("chat");
    }
    const identity = `${model.name} ${model.details?.family || ""}`.toLowerCase();
    return !/(embed|embedding|bert)/.test(identity);
}

function getRequestSize(characterCount) {
    if (!Number.isInteger(characterCount) || characterCount < 0) {
        throw new Error("Request size must be a non-negative character count.");
    }
    if (characterCount <= 2000) return "small";
    if (characterCount <= 6000) return "medium";
    return "large";
}

function validateModelPreference(body, current = {}) {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new Error("Model preferences must be a JSON object.");
    }
    const unknownFields = Object.keys(body).filter(field => !preferenceFields.includes(field));
    if (unknownFields.length > 0) {
        throw new Error(`Unknown model preference: ${unknownFields[0]}.`);
    }
    const preference = {};
    for (const field of preferenceFields) {
        const score = body[field] ?? current[field] ?? 3;
        if (!Number.isInteger(score) || score < 1 || score > 5) {
            throw new Error(`Model preference '${field}' must be an integer from 1 to 5.`);
        }
        preference[field] = score;
    }
    return preference;
}

function calculateOllamaModelRankings(models, preferences, grades, skill, size, jobStore = new Map(), preferredModel) {
    if (!skills.has(skill)) throw new Error("Skill must be 'coding' or 'thinking'.");
    if (!sizes.has(size)) throw new Error("Size must be 'small', 'medium', or 'large'.");

    const jobValues = jobStore instanceof Map ? [...jobStore.values()] : jobStore;
    return models.filter(isChatModel).map(model => {
        const preference = validateModelPreference(preferences[model.name] || {});
        const preferenceScore = (preference[skill] + preference[size]) / 2;
        const modelGrades = grades.filter(grade =>
            grade.provider === "ollama" && grade.model === model.name && grade.skill === skill
        );
        const feedbackScore = modelGrades.length === 0
            ? null
            : (modelGrades.reduce((total, grade) => total + grade.score, 0) + 3 * 3) /
                (modelGrades.length + 3);
        const activeJobs = jobValues.filter(job =>
            job.provider === "ollama" && job.model === model.name &&
            (job.status === "queued" || job.status === "running")
        ).length;
        const completedJobs = jobValues.filter(job =>
            job.provider === "ollama" && job.model === model.name && job.status === "completed"
        ).length;

        return {
            name: model.name,
            ...(typeof model.size === "number" ? { sizeBytes: model.size } : {}),
            ...(model.details ? { details: model.details } : {}),
            preference,
            preferenceScore: Number(preferenceScore.toFixed(2)),
            feedbackScore: feedbackScore === null ? null : Number(feedbackScore.toFixed(2)),
            score: Number((feedbackScore === null
                ? preferenceScore
                : preferenceScore * 0.75 + feedbackScore * 0.25).toFixed(2)),
            feedbackCount: modelGrades.length,
            activeJobs,
            completedJobs
        };
    }).sort((left, right) => right.score - left.score ||
        left.activeJobs - right.activeJobs ||
        Number(right.name === preferredModel) - Number(left.name === preferredModel) ||
        left.name.localeCompare(right.name))
        .map((model, index) => ({ rank: index + 1, ...model }));
}

module.exports = {
    calculateOllamaModelRankings,
    getRequestSize,
    isChatModel,
    preferenceFields,
    validateModelPreference
};
