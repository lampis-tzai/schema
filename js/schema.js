/*global module: false, require: false, console: false */
/*eslint new-cap: [0] */
'use strict';
var _ = require('underscore');
var S;

// Schemas are represented as nested variants, in the
// form [tag, options, ...params]. 'options' is a map
// holding metadata about the schema, such as title and
// description. Metadata that is part of the context,
// such as role, or 'isOptional', is represented as an
// 'annotation' tag. E.g.
// ['annotation', {role: 'max'}, ['number', [0]]]
// Annotations are only meaningful in the context of a composite
// type, such as array, object, or function.


// Schemas are represented as variants, using js arrays.  To allow using
// literals as a shorthand for array schemas, we need to distinguish them from
// the variants. Subclassing array in js is a mess, so instead use a hacky
// magic property to identify variants.
var schemaMagic = '_schema';

function isSchema(value) {
	return _.isArray(value) && value[schemaMagic];
}

function bless(schema) {
	schema[schemaMagic] = true;
	return schema;
}

var blessFn = fn => (...args) => bless(fn(...args));
var blessAll = obj => _.mapObject(obj, v => _.isFunction(v) ? blessFn(v): bless(v));

// Allow literal shorthand for some schemas.
function literals(value) {
	if (isSchema(value)) {
		return value;
	}
	if (_.isString(value)) {
		return S.string(value);
	}
	if (_.isNumber(value)) {
		return S.number(value);
	}
	if (_.isArray(value)) {
		return (value.length === 1) ? S.arrayOf(value[0]) : S.array(...value);
	}
	if (_.isObject(value) && !_.isArray(value) && !_.isFunction(value)) {
		return Object.keys(value).length === 1 ? S.objectOf(value) : S.object(value);
	}
	throw new Error(`Unknown schema value ${value}`);
}

///////////////////////////////////////////
// Horrible hack to allow reference keys, like
// { [myschema]: string() }
// By overriding the toString method of a schema, we can cause it
// to return a unique id when evaluated as an es6 computed key property.
// If we simultaneously cache the schema itself, indexed by this
// unique id, we can then use the key to find the schema in the cache when
// we are processing the key/value pairs of the object schema.
//
// Currently we only do this for schemas with a title, declared with desc(). This
// makes sense if we do not plan to in-line schemas for keys, but always link
// to them instead. So all schemas used as keys should be top-level.

// This is a persistent cache. If you process enough reference keys, you will
// eventually run out of memory.
var cache = {};
var magic = '__$$_$_$$'; // don't prefix your schema keys with this.

function refHandler(schema) {
	schema.toString = function () {
		var id = _.uniqueId(magic);
		cache[id] = this;
		return id;
	};
	return schema;
}
///////////////////////////////////////////


function keyType(k) {
	return (k[0] === '/' && k[k.length - 1] === '/') ? 'pattern' :
		(k.indexOf(magic) === 0 ? 'reference' : 'string');
}

var cases = (obj, type) => obj[type]();

// Identify pattern keys from object literal. Since objects can only have string
// keys, we are limited in what we can return here.
function key(schema, k) {
	return cases({
		'pattern': () => [S.string(new RegExp(k.slice(1, k.length - 1))), literals(schema)],
		'string': () => [S.string(k), literals(schema)],
		'reference': () => [cache[k], literals(schema)]
	}, keyType(k));
}

function partitionN(coll, n) {
	return _.range(coll.length / n).map(i => coll.slice(i * n, (i + 1) * n));
}

// In practice, this warning doesn't work because an 'or' of multiple
// string schemas is also correct. To do this properly would require walking
// the tree to ensure that the whole thing resolves to a string.
//function warnBadKey(sch) {
//	var [[type]] = sch;
//	if (type !== 'string') {
//		console.warn(`Bad key type ${type}`);
//	}
//	return sch;
//}

// Allow either an object literal, or a list of alternating keys and values.
// ({foo: bar, ...})
// ('foo', bar, ...)
// In the latter case, the key might be another schema. This is useful in the case
// where the key is defined by a schema object, however in javascript that schema
// object must be a string.
var objargs = (type, args) => args.length === 1 ?
	[type, {}, ..._.map(args[0], key)] :
	[type, {}, ...partitionN(args, 2).map(schs => schs.map(literals))];

S = module.exports = literals;

// merge, dropping undefined props
var m = (...objs) => _.pick(_.extend.apply(null, [{}, ...objs]), v => v !== undefined);

// how to represent 'required' (we really want to tag 'optional', not 'required')
var methods = blessAll({
	fn: function(...schemas) {
		var s = ['function', {}, null, ..._.map(schemas, literals)];
		// decorate with method for merging in the fn return schema.
		return _.extend(s,
			{to: blessFn(schema => [...s.slice(0, 2), schema, ...s.slice(3)])});
	},
    string: function (value) {
        var val = _.isString(value) ? ['value', value] :
            (_.isRegExp(value) ? ['pattern', value] : []);
        return ['string', {}, val];
    },
    number: function (value) {
        var val = _.isArray(value) ? ['interval', value] :
            (_.isNumber(value) ? ['value', value] : []);
        return ['number', {}, val];
    },
    or: function (...schemas) {
        return ['or', {}, ..._.map(schemas, literals)];
    },
    array: function (...schemas) {
        return ['tuple', {}, ..._.map(schemas, literals)];
    },
	arrayOf: function (schema) {
		return ['list', {}, literals(schema)];
	},
    desc: function (...args) {
        if (args.length === 2) {
            args.unshift(undefined);
        }
        var [title, description, schema] = args,
			[type, opts, ...rest] = literals(schema);
        return refHandler(
			[type,
				m({title: title, description: description}, opts),
				...rest]);
    },
	role: function (role, [type, opts, ...rest]) {
		return ['annotation', {role}, [type, opts, ...rest]];
	},
	object: (...args) => objargs('object', args),
	dict: (...args) => objargs('dict', args),
	boolean: ['boolean', {}],
	nullval: ['null', {}]
});

methods.objectOf = methods.dict;

_.extend(S, methods);
