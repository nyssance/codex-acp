import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        setupFiles: ["src/__tests__/native-catalog-setup.ts"],
        // Codex fixtures can download plugins with their own tests outside these owned directories.
        include: configDefaults.include.flatMap((pattern) => [
            `src/__tests__/${pattern}`,
            `scripts/${pattern}`,
        ]),
    },
});
