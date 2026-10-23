"use strict";

const path = require("node:path");

const sensitiveAssignment = /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|auth(?:orization)?|client[_-]?secret|secret|password|private[_-]?key|connection[_-]?string)["']?\s*[:=]\s*)("(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^"'\r\n,;}]+)/gi;
const dynamicSensitiveAssignment = new RegExp(
    sensitiveAssignment.source,
    "gi"
);
const sensitivePatterns = [
    /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----[\s\S]*?-----END \1-----/i,
    /\bBearer\s+[A-Za-z0-9._~+/=-]+/i,
    /\b(?:gh[pousr]_|github_pat_|AKIA|ASIA|AIza|sk-(?:live|prod|test)-)[A-Za-z0-9_-]{8,}/i,
    /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i
];

function isSensitiveFile(relativePath) {
    return relativePath.split(/[\\/]/).some(part => {
        const name = part.toLowerCase();
        return name.startsWith(".env") ||
            /(^|[._-])(secret|secrets|credential|credentials|private|token)([._-]|$)/i.test(name) ||
            /\.(pem|p12|pfx|key)$/i.test(name);
    });
}

function redactSensitiveText(text) {
    return text
        .replace(/-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----[\s\S]*?-----END \1-----/gi, "[REDACTED PRIVATE KEY]")
        .replace(sensitiveAssignment, (match, prefix, value) => {
            const quote = value[0] === "\"" || value[0] === "'" ? value[0] : "";
            return `${prefix}${quote}[REDACTED]${quote}`;
        })
        .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "******");
}

function hasSensitiveContent(text, { allowCodeExpressions = false } = {}) {
    if (sensitivePatterns.some(pattern => pattern.test(text))) return true;
    let content = text;
    if (allowCodeExpressions) {
        content = content.replace(dynamicSensitiveAssignment, (match, prefix, value) =>
            /["'`]/.test(value) ? match : "[DYNAMIC_REFERENCE]"
        );
    }
    return redactSensitiveText(content) !== content;
}

module.exports = {
    hasSensitiveContent,
    isSensitiveFile,
    redactSensitiveText
};
