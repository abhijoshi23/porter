import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      // stdout belongs to the stdio transport; a stray console.log corrupts the JSON-RPC stream.
      'no-console': ['error', { allow: ['error', 'warn'] }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // Invisible characters in source hide what code really does; write them as \u escapes.
      'no-irregular-whitespace': [
        'error',
        { skipStrings: false, skipTemplates: false, skipRegExps: false },
      ],
      // Bidi controls aren't whitespace, so the rule above misses them, yet they can make
      // code display differently from how it runs ("Trojan Source", CVE-2021-42574). Same
      // for other control characters: a literal backspace once hid inside a regex here.
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'Literal[raw=/[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F\\u202A-\\u202E\\u2066-\\u2069]/]',
          message: 'Write control and bidi characters as \\u escapes.',
        },
        {
          selector:
            'TemplateElement[value.raw=/[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F\\u202A-\\u202E\\u2066-\\u2069]/]',
          message: 'Write control and bidi characters as \\u escapes.',
        },
      ],
    },
  },
);
