// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import stylistic from "@stylistic/eslint-plugin";

export default tseslint.config(
	{ ignores: ["out", "node_modules", "**/*.d.ts", "**/*.js", "**/*.mjs"] },
	eslint.configs.recommended,
	...tseslint.configs.recommended,
	{
		plugins: { "@stylistic": stylistic },
		rules: {
			"@stylistic/semi": "warn",
			curly: "warn",
			"@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
			"@typescript-eslint/no-explicit-any": "off",
		},
	}
);
