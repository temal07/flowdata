import { collectVariables } from "./engine";

function extractQuery({ query, limit = 10 }: { query: string; limit?: number }) {
  return query.slice(0, limit);
}