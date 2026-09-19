// InputsView(db) -- plan.md "Design: environments": "Input reads go through
// a separate InputsView(db) (asOf required, as today)." The inputs DB's
// schema (migrations/inputs/) is byte-for-byte what these functions already
// query in storage/d1.js -- the split moves WHICH DATABASE they run
// against, not the SQL itself -- so this module re-exports them rather than
// duplicating ~300 lines of identical query code. Callers that only touch
// inputs data (news/price/fundamentals) should import from here going
// forward; storage/d1.js's own copies are for the OLD scope-less schema and
// get deleted (not just left as dead code) once M2 finishes moving the live
// pipeline over -- see plan.md's milestone list.
export {
  insertNewsItem,
  getNewsAsOf,
  getNewsItemsInRange,
  insertPriceBar,
  getPriceBarsAsOf,
  insertFundamentalFact,
  insertFundamentalFacts,
  getFundamentalFactsAsOf,
} from "./d1.js";
