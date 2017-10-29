"use strict";

import { Map, OrderedSet } from "immutable";

import { TypeScriptTargetLanguage } from "../TargetLanguage";
import {
    Type,
    TopLevels,
    NamedType,
    ClassType,
    UnionType,
    nullableFromUnion,
    matchType,
    removeNullFromUnion
} from "../Type";
import { Namespace, Name, Namer, funPrefixNamer } from "../Naming";
import { Sourcelike, maybeAnnotated } from "../Source";
import { anyTypeIssueAnnotation, nullTypeIssueAnnotation } from "../Annotation";
import {
    utf16LegalizeCharacters,
    camelCase,
    startWithLetter,
    isLetterOrUnderscore,
    isLetterOrUnderscoreOrDigit,
    utf16StringEscape,
    defined
} from "../Support";
import { RenderResult } from "../Renderer";
import { ConvenienceRenderer } from "../ConvenienceRenderer";
import { StringOption } from "../RendererOptions";

export default class CPlusPlusTargetLanguage extends TypeScriptTargetLanguage {
    private readonly _namespaceOption: StringOption;

    constructor() {
        const namespaceOption = new StringOption(
            "namespace",
            "Name of the generated namespace",
            "NAME",
            "quicktype"
        );
        super("C++", ["c++", "cpp", "cplusplus"], "cpp", [namespaceOption.definition]);
        this._namespaceOption = namespaceOption;
    }

    renderGraph(topLevels: TopLevels, optionValues: { [name: string]: any }): RenderResult {
        const renderer = new CPlusPlusRenderer(
            topLevels,
            this._namespaceOption.getValue(optionValues)
        );
        return renderer.render();
    }
}

const namingFunction = funPrefixNamer(cppNameStyle);

const legalizeName = utf16LegalizeCharacters(isLetterOrUnderscoreOrDigit);

function cppNameStyle(original: string): string {
    const legalized = legalizeName(original);
    const cameled = camelCase(legalized);
    return startWithLetter(isLetterOrUnderscore, false, cameled);
}

const keywords = [
    "alignas",
    "alignof",
    "and",
    "and_eq",
    "asm",
    "atomic_cancel",
    "atomic_commit",
    "atomic_noexcept",
    "auto",
    "bitand",
    "bitor",
    "bool",
    "break",
    "case",
    "catch",
    "char",
    "char16_t",
    "char32_t",
    "class",
    "compl",
    "concept",
    "const",
    "constexpr",
    "const_cast",
    "continue",
    "co_await",
    "co_return",
    "co_yield",
    "decltype",
    "default",
    "delete",
    "do",
    "double",
    "dynamic_cast",
    "else",
    "enum",
    "explicit",
    "export",
    "extern",
    "false",
    "float",
    "for",
    "friend",
    "goto",
    "if",
    "import",
    "inline",
    "int",
    "long",
    "module",
    "mutable",
    "namespace",
    "new",
    "noexcept",
    "not",
    "not_eq",
    "nullptr",
    "operator",
    "or",
    "or_eq",
    "private",
    "protected",
    "public",
    "register",
    "reinterpret_cast",
    "requires",
    "return",
    "short",
    "signed",
    "sizeof",
    "static",
    "static_assert",
    "static_cast",
    "struct",
    "switch",
    "synchronized",
    "template",
    "this",
    "thread_local",
    "throw",
    "true",
    "try",
    "typedef",
    "typeid",
    "typename",
    "union",
    "unsigned",
    "using",
    "virtual",
    "void",
    "volatile",
    "wchar_t",
    "while",
    "xor",
    "xor_eq",
    "override",
    "final",
    "transaction_safe",
    "transaction_safe_dynamic"
];

class CPlusPlusRenderer extends ConvenienceRenderer {
    constructor(topLevels: TopLevels, private readonly _namespaceName) {
        super(topLevels);
    }

    protected get forbiddenNamesForGlobalNamespace(): string[] {
        return keywords;
    }

    protected forbiddenForProperties(
        c: ClassType,
        classNamed: Name
    ): { names: Name[]; namespaces: Namespace[] } {
        return { names: [], namespaces: [this.globalNamespace] };
    }

    protected topLevelNameStyle(rawName: string): string {
        return cppNameStyle(rawName);
    }

    protected get namedTypeNamer(): Namer {
        return namingFunction;
    }

    protected get propertyNamer(): Namer {
        return namingFunction;
    }

    protected namedTypeToNameForTopLevel(type: Type): NamedType | null {
        if (type.isNamedType()) {
            return type;
        }
        return null;
    }

    private emitBlock = (line: Sourcelike, withSemicolon: boolean, f: () => void): void => {
        this.emitLine(line, " {");
        this.indent(f);
        if (withSemicolon) {
            this.emitLine("};");
        } else {
            this.emitLine("}");
        }
    };

    private emitNamespace = (namespaceName: string, f: () => void): void => {
        this.emitBlock(["namespace ", namespaceName], false, f);
    };

    private cppTypeInOptional = (
        nonNulls: OrderedSet<Type>,
        inJsonNamespace: boolean,
        withIssues: boolean
    ): Sourcelike => {
        if (nonNulls.size === 1) {
            return this.cppType(defined(nonNulls.first()), inJsonNamespace, withIssues);
        }
        const typeList: Sourcelike = [];
        nonNulls.forEach((t: Type) => {
            if (typeList.length !== 0) {
                typeList.push(", ");
            }
            typeList.push(this.cppType(t, inJsonNamespace, withIssues));
        });
        return ["boost::variant<", typeList, ">"];
    };

    private variantType = (u: UnionType, inJsonNamespace: boolean): Sourcelike => {
        const [hasNull, nonNulls] = removeNullFromUnion(u);
        if (nonNulls.size < 2) throw "Variant not needed for less than two types.";
        const variant = this.cppTypeInOptional(nonNulls, inJsonNamespace, true);
        if (!hasNull) {
            return variant;
        }
        return ["boost::optional<", variant, ">"];
    };

    private ourQualifier = (inJsonNamespace: boolean): Sourcelike => {
        return inJsonNamespace ? [this._namespaceName, "::"] : [];
    };

    private jsonQualifier = (inJsonNamespace: boolean): Sourcelike => {
        return inJsonNamespace ? [] : "nlohmann::";
    };

    private cppType = (t: Type, inJsonNamespace: boolean, withIssues: boolean): Sourcelike => {
        return matchType<Sourcelike>(
            t,
            anyType =>
                maybeAnnotated(withIssues, anyTypeIssueAnnotation, [
                    this.jsonQualifier(inJsonNamespace),
                    "json"
                ]),
            nullType =>
                maybeAnnotated(withIssues, nullTypeIssueAnnotation, [
                    this.jsonQualifier(inJsonNamespace),
                    "json"
                ]),
            boolType => "bool",
            integerType => "int64_t",
            doubleType => "double",
            stringType => "std::string",
            arrayType => [
                "std::vector<",
                this.cppType(arrayType.items, inJsonNamespace, withIssues),
                ">"
            ],
            classType => [
                "struct ",
                this.ourQualifier(inJsonNamespace),
                this.nameForNamedType(classType)
            ],
            mapType => [
                "std::map<std::string, ",
                this.cppType(mapType.values, inJsonNamespace, withIssues),
                ">"
            ],
            unionType => {
                const nullable = nullableFromUnion(unionType);
                if (!nullable)
                    return [this.ourQualifier(inJsonNamespace), this.nameForNamedType(unionType)];
                return [
                    "boost::optional<",
                    this.cppType(nullable, inJsonNamespace, withIssues),
                    ">"
                ];
            }
        );
    };

    private emitClass = (c: ClassType, className: Name): void => {
        this.emitBlock(["struct ", className], true, () => {
            this.forEachProperty(c, "none", (name, json, propertyType) => {
                this.emitLine(this.cppType(propertyType, false, true), " ", name, ";");
            });
        });
    };

    private emitClassFunctions = (c: ClassType, className: Name): void => {
        const ourQualifier = this.ourQualifier(true);
        this.emitBlock(
            ["void from_json(const json& _j, struct ", ourQualifier, className, "& _x)"],
            false,
            () => {
                this.forEachProperty(c, "none", (name, json, t) => {
                    if (t instanceof UnionType) {
                        const [hasNull, nonNulls] = removeNullFromUnion(t);
                        if (hasNull) {
                            this.emitLine(
                                "_x.",
                                name,
                                " = ",
                                ourQualifier,
                                "get_optional<",
                                this.cppTypeInOptional(nonNulls, true, false),
                                '>(_j, "',
                                utf16StringEscape(json),
                                '");'
                            );
                            return;
                        }
                    }
                    if (t.kind === "null" || t.kind === "any") {
                        this.emitLine(
                            "_x.",
                            name,
                            " = ",
                            ourQualifier,
                            'get_untyped(_j, "',
                            utf16StringEscape(json),
                            '");'
                        );
                        return;
                    }
                    const cppType = this.cppType(t, true, false);
                    this.emitLine(
                        "_x.",
                        name,
                        ' = _j.at("',
                        utf16StringEscape(json),
                        '").get<',
                        cppType,
                        ">();"
                    );
                });
            }
        );
        this.emitNewline();
        this.emitBlock(
            ["void to_json(json& _j, const struct ", ourQualifier, className, "& _x)"],
            false,
            () => {
                if (c.properties.isEmpty()) {
                    this.emitLine("_j = json::object();");
                    return;
                }
                const args: Sourcelike = [];
                this.forEachProperty(c, "none", (name, json, _) => {
                    if (args.length !== 0) {
                        args.push(", ");
                    }
                    args.push('{"', utf16StringEscape(json), '", _x.', name, "}");
                });
                this.emitLine("_j = json{", args, "};");
            }
        );
    };

    private emitUnionTypedefs = (u: UnionType, unionName: Name): void => {
        this.emitLine("typedef ", this.variantType(u, false), " ", unionName, ";");
    };

    private emitUnionFunctions = (u: UnionType): void => {
        const functionForKind: [string, string][] = [
            ["bool", "is_boolean"],
            ["integer", "is_number_integer"],
            ["double", "is_number"],
            ["string", "is_string"],
            ["class", "is_object"],
            ["map", "is_object"],
            ["array", "is_array"]
        ];
        const [_, nonNulls] = removeNullFromUnion(u);
        const variantType = this.cppTypeInOptional(nonNulls, true, false);
        this.emitBlock(["void from_json(const json& _j, ", variantType, "& _x)"], false, () => {
            let onFirst = true;
            for (const [kind, func] of functionForKind) {
                const t = nonNulls.find((t: Type) => t.kind === kind);
                if (t === undefined) continue;
                this.emitLine(onFirst ? "if" : "else if", " (_j.", func, "())");
                this.indent(() => {
                    this.emitLine("_x = _j.get<", this.cppType(t, true, false), ">();");
                });
                onFirst = false;
            }
            this.emitLine('else throw "Could not deserialize";');
        });
        this.emitNewline();
        this.emitBlock(["void to_json(json& _j, const ", variantType, "& _x)"], false, () => {
            this.emitBlock("switch (_x.which())", false, () => {
                let i = 0;
                nonNulls.forEach((t: Type) => {
                    this.emitLine("case ", i.toString(), ":");
                    this.indent(() => {
                        this.emitLine("_j = boost::get<", this.cppType(t, true, false), ">(_x);");
                        this.emitLine("break;");
                    });
                    i++;
                });
                this.emitLine('default: throw "This should not happen";');
            });
        });
    };

    private emitTopLevelTypedef = (t: Type, name: Name): void => {
        if (!this.namedTypeToNameForTopLevel(t)) {
            this.emitLine("typedef ", this.cppType(t, false, true), " ", name, ";");
        }
    };

    private emitAllUnionFunctions = (): void => {
        this.forEachUniqueUnion(
            "interposing",
            u =>
                this.sourcelikeToString(
                    this.cppTypeInOptional(removeNullFromUnion(u)[1], true, false)
                ),
            this.emitUnionFunctions
        );
    };

    private emitOptionalHelpers = (): void => {
        this.emitMultiline(`template <typename T>
struct adl_serializer<boost::optional<T>> {
    static void to_json(json& j, const boost::optional<T>& opt) {
        if (opt == boost::none) {
            j = nullptr;
        } else {
            j = *opt; // this will call adl_serializer<T>::to_json which will
            // find the free function to_json in T's namespace!
        }
    }
    
    static void from_json(const json& j, boost::optional<T>& opt) {
        if (j.is_null()) {
            opt = boost::none;
        } else {
            opt = j.get<T>(); // same as above, but with
            // adl_serializer<T>::from_json
        }
    }
};`);
    };

    protected emitSourceStructure(): void {
        this.emitLine("// To parse this JSON data, first install");
        this.emitLine("//");
        this.emitLine("//     Boost     http://www.boost.org");
        this.emitLine("//     json.hpp  https://github.com/nlohmann/json");
        this.emitLine("//");
        this.emitLine("// Then include this file, and then do");
        this.emitLine("//");
        this.forEachTopLevel("none", (_, topLevelName) => {
            this.emitLine(
                "//     ",
                this.ourQualifier(false),
                topLevelName,
                " data = nlohmann::json::parse(jsonString);"
            );
        });
        this.emitNewline();
        if (this.haveUnions) {
            this.emitLine("#include <boost/optional.hpp>");
        }
        if (this.haveNamedUnions) {
            this.emitLine("#include <boost/variant.hpp>");
        }
        this.emitLine('#include "json.hpp"');
        this.emitNewline();
        this.emitNamespace(this._namespaceName, () => {
            this.emitLine("using nlohmann::json;");
            this.forEachNamedType(
                "leading-and-interposing",
                true,
                this.emitClass,
                this.emitUnionTypedefs
            );
            this.forEachTopLevel("leading", this.emitTopLevelTypedef);
            this.emitMultiline(`
static json get_untyped(const json &j, const char *property) {
    if (j.find(property) != j.end()) {
        return j.at(property).get<json>();
    }
    return json();
}`);
            if (this.haveUnions) {
                this.emitMultiline(`
template <typename T>
static boost::optional<T> get_optional(const json &j, const char *property) {
    if (j.find(property) != j.end()) {
        return j.at(property).get<boost::optional<T>>();
    }
    return boost::optional<T>();
}`);
            }
        });
        this.emitNewline();
        this.emitNamespace("nlohmann", () => {
            if (this.haveUnions) {
                this.emitOptionalHelpers();
            }
            this.forEachClass("leading-and-interposing", this.emitClassFunctions);
            if (this.haveUnions) {
                this.emitNewline();
                this.emitAllUnionFunctions();
            }
        });
    }
}
