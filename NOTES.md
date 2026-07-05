### WHAT'S NEXT:

Function names into scope — rank's own uses is empty though it's called at line 7; function names go to the flat list, not a scope, so their uses don't resolve. Same fix-pattern you just applied twice.
Destructured params — node.params.map(makeBinding) still assumes simple identifiers; function k({query}) breaks it. Route params through collectPatternNames into the scope.
Block scope — if/for blocks create scopes too, not just functions. Currently only functions push.
The uses: [] on use-bindings — cosmetic modeling wart, the two-type refactor.
Then: the MCP wrapper — now there's a true, scope-correct payload worth serving.