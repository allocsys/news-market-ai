// A failing D1 whose every statement rejects -- for proving best-effort writes
// (LLM call log, job progress) never throw into the work they describe.
//
// Lives in test/helpers/ (not *.test.js) so `npm test`'s `find test -name
// '*.test.js'` doesn't try to run it as a test file.

export class BrokenDb {
  prepare() {
    return {
      bind() {
        return {
          async run() { throw new Error("D1 exploded"); },
          async all() { throw new Error("D1 exploded"); },
          async first() { throw new Error("D1 exploded"); },
        };
      },
    };
  }
}
