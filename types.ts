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
    role: "declaration" | "use";
}
