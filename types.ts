export type Kind = "function" |
    "param" |
    "class" |
    "variable" |
    "type" |
    "catch";

export interface Binding {
    name: string;
    line: number;
    varType: string;
    file: string;
    kind: Kind;
    start: number;
    role: "declaration" | "use";
}

export type Scope = {
    name: string;
    declarations: Binding[];
}
