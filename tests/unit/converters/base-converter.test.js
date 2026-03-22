import { describe, test, expect } from '@jest/globals';
import { BaseConverter, ContentProcessor, ToolProcessor } from '../../../src/converters/BaseConverter.js';

// Minimal concrete subclass for testing
class ConcreteConverter extends BaseConverter {
    constructor() {
        super('test-protocol');
    }
    convertRequest(data) { return { converted: true, data }; }
    convertResponse(data) { return { converted: true, data }; }
    convertStreamChunk(chunk) { return { converted: true, chunk }; }
    convertModelList(data) { return { converted: true, data }; }
}

// Partial subclass that doesn't override all methods
class PartialConverter extends BaseConverter {
    constructor() {
        super('partial');
    }
}

describe('BaseConverter', () => {
    test('cannot be instantiated directly', () => {
        expect(() => new BaseConverter('test')).toThrow('BaseConverter是抽象类，不能直接实例化');
    });

    test('subclass can be instantiated', () => {
        const converter = new ConcreteConverter();
        expect(converter).toBeInstanceOf(BaseConverter);
    });

    test('getProtocolName returns the protocol passed to constructor', () => {
        const converter = new ConcreteConverter();
        expect(converter.getProtocolName()).toBe('test-protocol');
    });

    test('convertRequest is callable on subclass', () => {
        const converter = new ConcreteConverter();
        const result = converter.convertRequest({ msg: 'hello' });
        expect(result.converted).toBe(true);
    });

    test('convertResponse is callable on subclass', () => {
        const converter = new ConcreteConverter();
        const result = converter.convertResponse({ text: 'hi' });
        expect(result.converted).toBe(true);
    });

    test('convertStreamChunk is callable on subclass', () => {
        const converter = new ConcreteConverter();
        const result = converter.convertStreamChunk({ delta: 'a' });
        expect(result.converted).toBe(true);
    });

    test('convertModelList is callable on subclass', () => {
        const converter = new ConcreteConverter();
        const result = converter.convertModelList({ models: [] });
        expect(result.converted).toBe(true);
    });

    test('unimplemented convertRequest throws on partial subclass', () => {
        const converter = new PartialConverter();
        expect(() => converter.convertRequest({})).toThrow('convertRequest方法必须被子类实现');
    });

    test('unimplemented convertResponse throws on partial subclass', () => {
        const converter = new PartialConverter();
        expect(() => converter.convertResponse({})).toThrow('convertResponse方法必须被子类实现');
    });

    test('unimplemented convertStreamChunk throws on partial subclass', () => {
        const converter = new PartialConverter();
        expect(() => converter.convertStreamChunk({})).toThrow('convertStreamChunk方法必须被子类实现');
    });

    test('unimplemented convertModelList throws on partial subclass', () => {
        const converter = new PartialConverter();
        expect(() => converter.convertModelList({})).toThrow('convertModelList方法必须被子类实现');
    });
});

describe('ContentProcessor', () => {
    test('process throws when not overridden', () => {
        const processor = new ContentProcessor();
        expect(() => processor.process('data')).toThrow('process方法必须被子类实现');
    });
});

describe('ToolProcessor', () => {
    test('processToolDefinitions throws when not overridden', () => {
        const processor = new ToolProcessor();
        expect(() => processor.processToolDefinitions([])).toThrow('processToolDefinitions方法必须被子类实现');
    });

    test('processToolCall throws when not overridden', () => {
        const processor = new ToolProcessor();
        expect(() => processor.processToolCall({})).toThrow('processToolCall方法必须被子类实现');
    });

    test('processToolResult throws when not overridden', () => {
        const processor = new ToolProcessor();
        expect(() => processor.processToolResult({})).toThrow('processToolResult方法必须被子类实现');
    });
});
