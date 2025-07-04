# Database Migration Bug Fix

## Bug Description

The condition `if (import.meta.url === \`file://${process.argv[1]}\`)` was always evaluating to `false` because:

- `import.meta.url` returns a file URL (e.g., `file:///path/to/file.ts`)
- `process.argv[1]` returns a file path string (e.g., `/path/to/file.ts`)

This prevented the `main()` function from executing when the script was run directly.

## Fix Applied

The bug has been fixed by using `fileURLToPath(import.meta.url)` to normalize the file URL to a file path before comparison:

```typescript
import { fileURLToPath } from 'url';

// Fixed condition - using fileURLToPath to convert file URL to file path
if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(console.error);
}
```

## Files Modified

- `src/server/database/migrate.ts` - Applied the fix at lines 208-209
- `package.json` - Added Node.js type definitions
- `tsconfig.json` - Added TypeScript configuration for proper compilation

## How to Run

### JavaScript Version (Ready to run)
```bash
npm run migrate
# or
node src/server/database/migrate.js
```

### TypeScript Version (Requires tsx)
```bash
npm install tsx
npm run migrate:ts
# or
npx tsx src/server/database/migrate.ts
```

### Compile TypeScript to JavaScript
```bash
npm run build
node dist/server/database/migrate.js
```

The migration function will now execute correctly when the script is run directly thanks to the fix.