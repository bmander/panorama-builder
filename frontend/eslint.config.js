import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: ['build/**', 'node_modules/**', 'eslint.config.js'],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      // tsconfig has `noUncheckedIndexedAccess: true`, which makes `arr[i]`
      // type `T | undefined`. In numerical code (solver.ts) and Leaflet
      // call sites (map.ts), the `!` operator is the idiomatic way to
      // assert "I know this is in bounds" — the alternative is runtime
      // checks that would mangle the math or duplicate constraints
      // already enforced by the surrounding loop bounds.
      '@typescript-eslint/no-non-null-assertion': 'off',

      // Number-in-template-literal is a legitimate use case (HUD readouts,
      // map coordinates). The `.toString()` boilerplate buys nothing.
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true },
      ],
    },
  },
);
