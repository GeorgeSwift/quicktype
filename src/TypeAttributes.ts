"use strict";

import { Map, OrderedSet, hash } from "immutable";

import { panic, setUnion } from "./Support";
export class TypeAttributeKind<T> {
    public readonly combine: (a: T, b: T) => T;

    constructor(readonly name: string, combine: ((a: T, b: T) => T) | undefined) {
        if (combine === undefined) {
            combine = () => {
                return panic(`Cannot combine type attribute ${name}`);
            };
        }
        this.combine = combine;
    }

    makeAttributes(value: T): TypeAttributes {
        const kvps: [this, T][] = [[this, value]];
        return Map(kvps);
    }

    tryGetInAttributes(a: TypeAttributes): T | undefined {
        return a.get(this);
    }

    setInAttributes(a: TypeAttributes, value: T): TypeAttributes {
        return a.set(this, value);
    }

    modifyInAttributes(a: TypeAttributes, modify: (value: T | undefined) => T | undefined): TypeAttributes {
        const modified = modify(this.tryGetInAttributes(a));
        if (modified === undefined) {
            return a.remove(this);
        }
        return this.setInAttributes(a, modified);
    }

    setDefaultInAttributes(a: TypeAttributes, makeDefault: () => T): TypeAttributes {
        if (this.tryGetInAttributes(a) !== undefined) return a;
        return this.modifyInAttributes(a, makeDefault);
    }

    equals(other: any): boolean {
        if (!(other instanceof TypeAttributeKind)) {
            return false;
        }
        return this.name === other.name;
    }

    hashCode(): number {
        return hash(this.name);
    }
}

export type TypeAttributes = Map<TypeAttributeKind<any>, any>;

export const emptyTypeAttributes: TypeAttributes = Map();

export function combineTypeAttributes(attributeArray: TypeAttributes[]): TypeAttributes {
    if (attributeArray.length === 0) return Map();
    const first = attributeArray[0];
    const rest = attributeArray.slice(1);
    return first.mergeWith((aa, ab, kind) => kind.combine(aa, ab), ...rest);
}

export const descriptionTypeAttributeKind = new TypeAttributeKind<OrderedSet<string>>("description", setUnion);
export const propertyDescriptionsTypeAttributeKind = new TypeAttributeKind<Map<string, OrderedSet<string>>>(
    "propertyDescriptions",
    (a, b) => a.mergeWith(setUnion, b)
);
