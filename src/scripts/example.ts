// Builds a TF-IDF vector: term frequency weighted by the supplied idf. Terms
// absent from the corpus fall back to a neutral weight of 1.
const vectoriseTfIdf = (tokens, idf) => {
    const tf = vectorise(tokens);   // ← does `tokens` still feed `tf`?
};