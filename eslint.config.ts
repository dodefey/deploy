import eslint from "@eslint/js"
import eslintConfigPrettier from "eslint-config-prettier/flat"
import { defineConfig } from "eslint/config"
import tseslint from "typescript-eslint"

export default defineConfig(
	{
		ignores: [
			"dist/**",
			"node_modules/**",
			"*.config.ts",
			"tests/**",
			".prettierrc.*",
		],
	},
	{
		files: ["src/**/*.ts"],
		languageOptions: {
			parserOptions: {
				project: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
	},
	eslint.configs.recommended,
	tseslint.configs.strictTypeChecked,
	eslintConfigPrettier,
)
