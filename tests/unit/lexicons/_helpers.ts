import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const FIXTURES_DIR = join(__dirname, '..', '..', 'fixtures', 'com', 'smellgate')

function loadFixture(name: string): unknown {
  const raw = readFileSync(join(FIXTURES_DIR, name), 'utf8')
  return JSON.parse(raw)
}

/**
 * List all fixture files matching the given prefix.
 *
 * A fixture named `<recordType>.valid.json` is a valid example;
 * files named `<recordType>.invalid.<reason>.json` are invalid examples.
 */
export function loadFixturesForRecord(recordType: string): {
  valid: { name: string; value: unknown }[]
  invalid: { name: string; value: unknown }[]
} {
  const allFiles = readdirSync(FIXTURES_DIR)
  const validPrefix = `${recordType}.valid`
  const invalidPrefix = `${recordType}.invalid.`

  const valid = allFiles
    .filter((f) => f === `${validPrefix}.json` || f.startsWith(`${validPrefix}.`))
    .map((name) => ({ name, value: loadFixture(name) }))
  const invalid = allFiles
    .filter((f) => f.startsWith(invalidPrefix))
    .map((name) => ({ name, value: loadFixture(name) }))

  return { valid, invalid }
}
