import {defineConfig} from "vitest/config";

const appServerTests = [
    "src/__tests__/CodexACPAgent/CodexAcpClient.test.ts",
    "src/__tests__/CodexACPAgent/mcp-session.test.ts",
    "src/__tests__/CodexACPAgent/mcp-config-merge.test.ts",
];

export default defineConfig({
    test: {
        pool: "threads",
        maxWorkers: 4,
        projects: [
            {
                extends: true,
                test: {
                    name: "unit",
                    include: ["src/__tests__/**/*.test.ts"],
                    exclude: ["src/__tests__/integration/**", "src/__tests__/CodexACPAgent/e2e/**", ...appServerTests],
                    setupFiles: ["./src/__tests__/native-catalog-setup.ts"],
                },
            },
            {
                extends: true,
                test: {
                    name: "integration",
                    include: ["src/__tests__/integration/**/*.test.ts"],
                    setupFiles: ["./src/__tests__/native-catalog-setup.ts"],
                },
            },
            {
                extends: true,
                test: {name: "e2e", include: ["src/__tests__/CodexACPAgent/e2e/**/*.test.ts"]},
            },
            {
                extends: true,
                test: {name: "app-server", include: appServerTests},
            },
        ],
    },
});
