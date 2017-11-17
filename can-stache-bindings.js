// # can-stache-bindings.js
//
// This module provides CanJS's default data and event bindings.
// It's broken up into several parts:
//
// - Behaviors - Binding behaviors that run given an attribute or element.
// - Attribute Syntaxes - Hooks up custom attributes to their behaviors.
// - getObservableFrom - Methods that return a observable cross bound to the scope, viewModel, or element.
// - bind - Methods for setting up cross binding
// - getBindingInfo - A helper that returns the details of a data binding given an attribute.
// - makeDataBinding - A helper method for setting up a data binding.
// - initializeValues - A helper that initializes a data binding.
var expression = require('can-stache/src/expression');
var viewCallbacks = require('can-view-callbacks');
var Scope = require('can-view-scope');
var canViewModel = require('can-view-model');
var observeReader = require('can-stache-key');
var Observation = require('can-observation');
var SimpleObservable = require('can-simple-observable');

var assign = require('can-util/js/assign/assign');
var makeArray  = require('can-util/js/make-array/make-array');
var each  = require('can-util/js/each/each');
var dev = require('can-log/dev/dev');
var domEvents = require('can-util/dom/events/events');
require('can-util/dom/events/removed/removed');
var domData = require('can-util/dom/data/data');
var attr = require('can-util/dom/attr/attr');
var stacheHelperCore = require("can-stache/helpers/core");
var canSymbol = require("can-symbol");
var canReflect = require("can-reflect");
var mutateDeps = require('can-reflect-mutate-dependencies');
var singleReference = require("can-util/js/single-reference/single-reference");
var encoder = require("can-attribute-encoder");
var queues = require("can-queues");
var SettableObservable = require("can-simple-observable/setter/setter");
var makeCompute = require("can-view-scope/make-compute-like");

var addEnterEvent = require('can-event-dom-enter/compat');
addEnterEvent(domEvents);

var addRadioChange = require('can-event-dom-radiochange/compat');
addRadioChange(domEvents);

var canEvent = {
	on: function(eventName, handler, queue) {
		var listenWithDOM = domEvents.canAddEventListener.call(this);
		if(listenWithDOM) {
			domEvents.addEventListener.call(this, eventName, handler, queue);
		} else {
			canReflect.onKeyValue(this, eventName, handler, queue);
		}
	},
	off: function(eventName, handler, queue) {
		var listenWithDOM = domEvents.canAddEventListener.call(this);
		if(listenWithDOM) {
			domEvents.removeEventListener.call(this, eventName, handler, queue);
		} else {
			canReflect.offKeyValue(this, eventName, handler, queue);
		}
	},
	one: function(event, handler, queue) {
		// Unbind the listener after it has been executed
		var one = function() {
			canEvent.off.call(this, event, one, queue);
			return handler.apply(this, arguments);
		};

		// Bind the altered listener
		canEvent.on.call(this, event, one, queue);
		return this;
	}
};

var noop = function() {};

var onMatchStr = "on:",
	vmMatchStr = "vm:",
	elMatchStr = "el:",
	byMatchStr = ":by:",
	toMatchStr = ":to",
	fromMatchStr = ":from",
	bindMatchStr = ":bind",
	attributesEventStr = "attributes",
	removedStr = "removed",
	viewModelBindingStr = "viewModel",
	attributeBindingStr = "attribute",
	scopeBindingStr = "scope",
	viewModelOrAttributeBindingStr = "viewModelOrAttribute",
	getValueSymbol = canSymbol.for("can.getValue"),
	setValueSymbol = canSymbol.for("can.setValue"),
	onValueSymbol = canSymbol.for("can.onValue"),
	offValueSymbol = canSymbol.for("can.offValue"),
	getWhatIChangeSymbol = canSymbol.for("can.getWhatIChange"),
	getChangesSymbol = canSymbol.for("can.getChangesDependencyRecord"),
	valueHasDependenciesSymbol = canSymbol.for("can.valueHasDependencies");


var throwOnlyOneTypeOfBindingError = function(){
	throw new Error("can-stache-bindings - you can not have contextual bindings ( this:from='value' ) and key bindings ( prop:from='value' ) on one element.");
};

// This function checks if there bindings that are trying
// to set a property ON the viewModel _conflicting_ with bindings trying to
// set THE viewModel ITSELF.
// If there is a conflict, an error is thrown.
var checkBindingState = function(bindingState, dataBinding) {
	var isSettingOnViewModel = dataBinding.bindingInfo.parentToChild && dataBinding.bindingInfo.child === viewModelBindingStr;
	if(isSettingOnViewModel) {
		var bindingName = dataBinding.bindingInfo.childName;
		var isSettingViewModel = isSettingOnViewModel && ( bindingName === 'this' || bindingName === '.' );

		if( isSettingViewModel ) {
			if(bindingState.isSettingViewModel || bindingState.isSettingOnViewModel) {
				throwOnlyOneTypeOfBindingError();
			} else {
				return {isSettingViewModel: true, initialViewModelData: undefined};
			}
		} else {
			// just setting on viewModel
			if(bindingState.isSettingViewModel) {
				throwOnlyOneTypeOfBindingError();
			} else {
				return {isSettingOnViewModel: true, initialViewModelData: bindingState.initialViewModelData};
			}
		}
	} else {
		return bindingState;
	}
};

// ## Behaviors
var behaviors = {
	// ### bindings.behaviors.viewModel
	// Sets up all of an element's data binding attributes to a "soon-to-be-created"
	// `viewModel`.
	// This is primarily used by `can.Component` to ensure that its
	// `viewModel` is initialized with values from the data bindings as quickly as possible.
	// Component could look up the data binding values itself.  However, that lookup
	// would have to be duplicated when the bindings are established.
	// Instead, this uses the `makeDataBinding` helper, which allows creation of the `viewModel`
	// after scope values have been looked up.
	//
	// - `makeViewModel(initialViewModelData)` - a function that returns the `viewModel`.
	// - `initialViewModelData` any initial data that should already be added to the `viewModel`.
	//
	// Returns:
	// - `function` - a function that tears all the bindings down. Component
	// wants all the bindings active so cleanup can be done during a component being removed.
	viewModel: function(el, tagData, makeViewModel, initialViewModelData, staticDataBindingsOnly) {

		var bindingsSemaphore = {},
			viewModel,
			// Stores callbacks for when the viewModel is created.
			onCompleteBindings = [],
			// Stores what needs to be called when the element is removed
			// to prevent memory leaks.
			onTeardowns = {},
			// Track info about each binding, we need this for binding attributes correctly.
			bindingInfos = {},
			attributeViewModelBindings = assign({}, initialViewModelData),
			bindingsState = {
				// if we have a binding like {something}="foo"
				isSettingOnViewModel: false,
				// if we have binding like {this}="bar"
				isSettingViewModel: false,
				initialViewModelData: initialViewModelData || {}
			},
			hasDataBinding = false;

		// For each attribute, we start the binding process,
		// and save what's returned to be used when the `viewModel` is created,
		// the element is removed, or the attribute changes values.
		each(makeArray(el.attributes), function(node) {
			var dataBinding = makeDataBinding(node, el, {
				templateType: tagData.templateType,
				scope: tagData.scope,
				semaphore: bindingsSemaphore,
				getViewModel: function() {
					return viewModel;
				},
				attributeViewModelBindings: attributeViewModelBindings,
				alreadyUpdatedChild: true,
				nodeList: tagData.parentNodeList,
				// force viewModel bindings in cases when it is ambiguous whether you are binding
				// on viewModel or an attribute (:to, :from, :bind)
				favorViewModel: true
			});

			if(dataBinding) {
				bindingsState = checkBindingState(bindingsState, dataBinding);
				hasDataBinding = true;


				// For bindings that change the viewModel,
				if(dataBinding.onCompleteBinding) {
					// save the initial value on the viewModel.
					if(dataBinding.bindingInfo.parentToChild && dataBinding.value !== undefined) {

						if(bindingsState.isSettingViewModel) {
							// the initial data is the context
							bindingsState.initialViewModelData = dataBinding.value;
						} else {
							bindingsState.initialViewModelData[cleanVMName(dataBinding.bindingInfo.childName)] = dataBinding.value;
						}

					}
					// Save what needs to happen after the `viewModel` is created.
					onCompleteBindings.push(dataBinding.onCompleteBinding);
				}
				onTeardowns[node.name] = dataBinding.onTeardown;
			}
		});
		if(staticDataBindingsOnly && !hasDataBinding) {
			return;
		}
		// Create the `viewModel` and call what needs to happen after `viewModel` is created.
		viewModel = makeViewModel(bindingsState.initialViewModelData, hasDataBinding);

		for(var i = 0, len = onCompleteBindings.length; i < len; i++) {
			onCompleteBindings[i]();
		}

		// Listen to attribute changes and re-initialize
		// the bindings.
		if(!bindingsState.isSettingViewModel) {
			domEvents.addEventListener.call(el, attributesEventStr, function (ev) {
				var attrName = ev.attributeName,
					value = el.getAttribute(attrName);

				if( onTeardowns[attrName] ) {
					onTeardowns[attrName]();
				}
				// Parent attribute bindings we always re-setup.
				var parentBindingWasAttribute = bindingInfos[attrName] && bindingInfos[attrName].parent === attributeBindingStr;

				if(value !== null || parentBindingWasAttribute ) {
					var dataBinding = makeDataBinding({name: attrName, value: value}, el, {
						templateType: tagData.templateType,
						scope: tagData.scope,
						semaphore: {},
						getViewModel: function() {
							return viewModel;
						},
						attributeViewModelBindings: attributeViewModelBindings,
						// always update the viewModel accordingly.
						initializeValues: true,
						nodeList: tagData.parentNodeList
					});
					if(dataBinding) {
						// The viewModel is created, so call callback immediately.
						if(dataBinding.onCompleteBinding) {
							dataBinding.onCompleteBinding();
						}
						bindingInfos[attrName] = dataBinding.bindingInfo;
						onTeardowns[attrName] = dataBinding.onTeardown;
					}
				}
			});
		}

		return function() {
			for(var attrName in onTeardowns) {
				onTeardowns[attrName]();
			}
		};
	},
	// ### bindings.behaviors.data
	// This is called when an individual data binding attribute is placed on an element.
	// For example `{^value}="name"`.
	data: function(el, attrData) {
		if(domData.get.call(el, "preventDataBindings")) {
			return;
		}
		var viewModel,
			getViewModel = Observation.ignore(function() {
				return viewModel || (viewModel = canViewModel(el));
			}),
			semaphore = {},
			teardown;


			// Setup binding
			var dataBinding = makeDataBinding({
				name: attrData.attributeName,
				value: el.getAttribute(attrData.attributeName),
				nodeList: attrData.nodeList
			}, el, {
				templateType: attrData.templateType,
				scope: attrData.scope,
				semaphore: semaphore,
				getViewModel: getViewModel,
				syncChildWithParent: false
			});

			//!steal-remove-start
			if(dataBinding.bindingInfo.child === "viewModel" && !domData.get(el, "viewModel")) {
				dev.warn('This element does not have a viewModel. (Attempting to bind `' + dataBinding.bindingInfo.bindingAttributeName + '="' + dataBinding.bindingInfo.parentName + '"`)');
			}
			//!steal-remove-end

			if(dataBinding.onCompleteBinding) {
				dataBinding.onCompleteBinding();
			}

			teardown = dataBinding.onTeardown;
			canEvent.one.call(el, removedStr, function() {
				teardown();
			});

			// Listen for changes
			domEvents.addEventListener.call(el, attributesEventStr, function (ev) {
				var attrName = ev.attributeName,
					value = el.getAttribute(attrName);

				if( attrName === attrData.attributeName ) {
					if( teardown ) {
						teardown();
					}

					if(value !== null  ) {
						var dataBinding = makeDataBinding({name: attrName, value: value}, el, {
							templateType: attrData.templateType,
							scope: attrData.scope,
							semaphore: semaphore,
							getViewModel: getViewModel,
							// always update the viewModel accordingly.
							initializeValues: true,
							nodeList: attrData.nodeList,
							syncChildWithParent: false
						});
						if(dataBinding) {
							// The viewModel is created, so call callback immediately.
							if(dataBinding.onCompleteBinding) {
								dataBinding.onCompleteBinding();
							}
							teardown = dataBinding.onTeardown;
						}
					}
				}
			});
	},
	// ### bindings.behaviors.event
	// The following section contains code for implementing the can-EVENT attribute.
	// This binds on a wildcard attribute name. Whenever a view is being processed
	// and can-xxx (anything starting with can-), this callback will be run.  Inside, its setting up an event handler
	// that calls a method identified by the value of this attribute.
	event: function(el, data) {

		// Get the `event` name and if we are listening to the element or viewModel.
		// The attribute name is the name of the event.
		var attributeName = encoder.decode( data.attributeName ),
			// the name of the event we are binding
			event,
			// if we are binding on the element or the VM
			bindingContext;

		// check for `on:event:value:to` type things and call data bindings
		if(attributeName.indexOf(toMatchStr+":") !== -1 ||
			attributeName.indexOf(fromMatchStr+":") !== -1 ||
			attributeName.indexOf(bindMatchStr+":") !== -1
		) {
			return this.data(el, data);
		}


		if(startsWith.call(attributeName, onMatchStr)) {
			event = attributeName.substr(onMatchStr.length);
			var viewModel = domData.get.call(el, viewModelBindingStr);

			// when using on:prop:by:obj
			// bindingContext should be scope.obj
			var byParent = data.scope;

			// get the bindingContext
			// on:el:prop -> bindingContext = element
			// on:vm:prop -> bindingContext = viewModel
			// otherwise,
			// bind on the element if there is not a viewModel
			if (startsWith.call(event, elMatchStr)) {
				event = event.substr(elMatchStr.length);
				bindingContext = el;
			} else {
				if (startsWith.call(event, vmMatchStr)) {
					event = event.substr(vmMatchStr.length);
					bindingContext = viewModel;

					// when using on:vm:prop:by:obj
					// bindingContext should be viewModel.obj
					byParent = viewModel;
				} else {
					bindingContext = viewModel || el;
				}

				// update the bindingContext and event if using :by:
				// on:prop:by:obj
				//   -> bindingContext = byParent.get('obj')
				//   -> event = 'prop'
				var byIndex = event.indexOf(byMatchStr);
				if( byIndex >= 0 ) {
					bindingContext = byParent.get(event.substr(byIndex + byMatchStr.length));
					event = event.substr(0, byIndex);
				}
			}
		} else {
			throw new Error("can-stache-bindings - unsupported event bindings "+attributeName);
		}

		// This is the method that the event will initially trigger. It will look up the method by the string name
		// passed in the attribute and call it.
		var handler = function (ev) {
			var attrVal = el.getAttribute( encoder.encode(attributeName) );
			if (!attrVal) { return; }

			var viewModel = canViewModel(el);

			// expression.parse will read the attribute
			// value and parse it identically to how mustache helpers
			// get parsed.
			var expr = expression.parse(attrVal,{
				lookupRule: function() {
					return expression.Lookup;
				}, methodRule: "call"});


			if(!(expr instanceof expression.Call)) {
				throw new Error("can-stache-bindings: Event bindings must be a call expression. Make sure you have a () in "+data.attributeName+"="+JSON.stringify(attrVal));
			}

			// create "spcial" values that can be looked up using
			// {{scope.element}}, etc
			var specialValues = {
				element: el,
				event: ev,
				viewModel: viewModel,
				arguments: arguments
			};

			// make a scope with these things just under
			var localScope = data.scope
				.add(specialValues, { special: true });

			// We grab the first item and treat it as a method that
			// we'll call.
			var scopeData = localScope.read(expr.methodExpr.key, {
				isArgument: true
			}),
			args, stacheHelper, stacheHelperResult;

			if (!scopeData.value) {
				// nothing found yet, look for a stache helper
				var name = observeReader.reads(expr.methodExpr.key).map(function(part) {
					return part.key;
				}).join(".");

				stacheHelper = stacheHelperCore.getHelper(name);
				if(stacheHelper) {
					args = expr.args(localScope, null)();
					stacheHelperResult = stacheHelper.fn.apply(localScope.peek("."), args);
					if(typeof stacheHelperResult === "function") {
						stacheHelperResult(el);
					}
					return stacheHelperResult;
				}

				//!steal-remove-start
				dev.warn("can-stache-bindings: " + attributeName + " couldn't find method named " + expr.methodExpr.key, {
					element: el,
					scope: data.scope
				});
				//!steal-remove-end

				return null;
			}

			args = expr.args(localScope, null)();
			queues.batch.start();
			queues.notifyQueue.enqueue(scopeData.value, scopeData.parent, args, {
				//!steal-remove-start
				reasonLog: [el, ev, attributeName+"="+attrVal]
				//!steal-remove-end
			});
			queues.batch.stop();

		};

		// Unbind the event when the attribute is removed from the DOM
		var attributesHandler = function(ev) {
			var isEventAttribute = ev.attributeName === attributeName;
			var isRemoved = !this.getAttribute(attributeName);
			var isEventAttributeRemoved = isEventAttribute && isRemoved;
			if (isEventAttributeRemoved) {
				unbindEvent();
			}
		};
		// Unbind the event when the target is removed from the DOM
		var removedHandler = function(ev) {
			unbindEvent();
		};
		var unbindEvent = function() {
			canEvent.off.call(bindingContext, event, handler);
			canEvent.off.call(el, attributesEventStr, attributesHandler);
			canEvent.off.call(el, removedStr, removedHandler);
		};

		// Bind the handler defined above to the element we're currently processing and the event name provided in this
		// attribute name (can-click="foo")
		canEvent.on.call(bindingContext, event, handler);
		canEvent.on.call(el, attributesEventStr, attributesHandler);
		canEvent.on.call(el, removedStr, removedHandler);
	}
};


// ## Attribute Syntaxes
// The following sets up the bindings functions to be called
// when called in a template.


// value:to="bar" data bindings
// these are separate so that they only capture at the end
// to avoid (toggle)="bar" which is encoded as :lp:toggle:rp:="bar"
viewCallbacks.attr(/[\w\.:]+:to$/, behaviors.data);
viewCallbacks.attr(/[\w\.:]+:from$/, behaviors.data);
viewCallbacks.attr(/[\w\.:]+:bind$/, behaviors.data);
// value:to:on:input="bar" data bindings
viewCallbacks.attr(/[\w\.:]+:to:on:[\w\.:]+/, behaviors.data);
viewCallbacks.attr(/[\w\.:]+:from:on:[\w\.:]+/, behaviors.data);
viewCallbacks.attr(/[\w\.:]+:bind:on:[\w\.:]+/, behaviors.data);


// `(EVENT)` event bindings.
viewCallbacks.attr(/on:[\w\.:]+/, behaviors.event);

// ## getObservableFrom
// An object of helper functions that make a getter/setter observable
// on different types of objects.
var getObservableFrom = {
	// ### getObservableFrom.viewModelOrAttribute
	viewModelOrAttribute: function(el, scope, vmNameOrProp, bindingData, mustBeSettable, stickyCompute, event) {
		var viewModel = domData.get.call(el, viewModelBindingStr);

		// if we have a viewModel, use it; otherwise, setup attribute binding
		if (viewModel) {
			return this.viewModel.apply(this, arguments);
		} else {
			return this.attribute.apply(this, arguments);
		}
	},
	// ### getObservableFrom.scope
	// Returns a compute from the scope.  This handles expressions like `someMethod(.,1)`.
	scope: function(el, scope, scopeProp, bindingData, mustBeSettable, stickyCompute) {
		if(!scopeProp) {
			return new SimpleObservable();
		} else {
			if(mustBeSettable) {
				var parentExpression = expression.parse(scopeProp,{baseMethodType: "Call"});
				return parentExpression.value(scope, new Scope.Options({}));
			} else {
				var observation = {};

				observation[getValueSymbol] = function() {};

				observation[valueHasDependenciesSymbol] = function() {
					return false;
				};

				observation[setValueSymbol] = function setValue(newVal) {
					scope.set(cleanVMName(scopeProp), newVal);
				};

				// Register what the custom observation changes
				observation[getWhatIChangeSymbol] = function() {
					var data = scope.getDataForScopeSet(cleanVMName(scopeProp));

					return {
						mutate: {
							keyDependencies: new Map([
								[data.parent, new Set([data.key])]
							])
						}
					};
				};

				// Register what changes the Scope's parent key
				var data = scope.getDataForScopeSet(cleanVMName(scopeProp));
				if (data.parent && data.key) {
					mutateDeps.addMutatedBy(data.parent, data.key, observation);
				}

				return observation;
			}
		}
	},
	// ### getObservableFrom.viewModel
	// Returns a compute that's two-way bound to the `viewModel` returned by
	// `options.getViewModel()`.
	viewModel: function(el, scope, vmName, bindingData, mustBeSettable, stickyCompute, childEvent) {
		var setName = cleanVMName(vmName);
		var isBoundToContext = vmName === "." || vmName === "this";
		var keysToRead = isBoundToContext ? [] : observeReader.reads(vmName);

		function getViewModelProperty() {
			var viewModel = bindingData.getViewModel();
			return observeReader.read(viewModel, keysToRead, {}).value;
		}
		//!steal-remove-start
		Object.defineProperty(getViewModelProperty, "name", {
			value: "viewModel."+vmName
		});
		//!steal-remove-end

		var observation = new SettableObservable(getViewModelProperty,function setViewModelProperty(newVal){
			var viewModel = bindingData.getViewModel();
			if(stickyCompute) {
				// TODO: Review what this is used for.
				var oldValue = canReflect.getKeyValue(viewModel, setName);
				if (canReflect.isObservableLike(oldValue)) {
					canReflect.setValue(oldValue, newVal);
				} else {
					canReflect.setKeyValue(viewModel, setName, new SimpleObservable(canReflect.getValue(stickyCompute)));
				}
			} else {
				if(isBoundToContext) {
					canReflect.setValue(viewModel, newVal);
				} else {
					canReflect.setKeyValue(viewModel, setName, newVal);
				}

			}
		});

		return observation;
	},
	// ### getObservableFrom.attribute
	// Returns a compute that is two-way bound to an attribute or property on the element.
	attribute: function(el, scope, prop, bindingData, mustBeSettable, stickyCompute, event, bindingInfo) {
		// Determine the event or events we need to listen to
		// when this value changes.
		if(!event) {
			event = "change";
			var isRadioInput = el.nodeName === 'INPUT' && el.type === 'radio';
			var isValidProp = prop === 'checked' && !bindingData.legacyBindings;
			if (isRadioInput && isValidProp) {
				event = 'radiochange';
			}

			var isSpecialProp = attr.special[prop] && attr.special[prop].addEventListener;
			if (isSpecialProp) {
				event = prop;
			}
		}

		var hasChildren = el.nodeName.toLowerCase() === "select",
			isMultiselectValue = prop === "value" && hasChildren && el.multiple,
			// Sets the element property or attribute.
			set = function(newVal) {
				if(bindingData.legacyBindings && hasChildren &&
					("selectedIndex" in el) && prop === "value") {
					attr.setAttrOrProp(el, prop, newVal == null ? "" : newVal);
				} else {
					attr.setAttrOrProp(el, prop, newVal);
				}

				return newVal;
			},
			get = function() {
				return attr.get(el, prop);
			};

			if(isMultiselectValue) {
				prop = "values";
			}

			var observation = new Observation(get);

			observation[setValueSymbol] = set;
			observation[getValueSymbol] = get;

			var onValue = observation[onValueSymbol];
			observation[onValueSymbol] = function(updater) {
				onValue.apply(this, arguments);

				var translationHandler = function() {
					updater(get());
				};
				singleReference.set(updater, this, translationHandler);

				if (event === "radiochange") {
					canEvent.on.call(el, "change", translationHandler);
				}

				canEvent.on.call(el, event, translationHandler);
			};

			var offValue = observation[offValueSymbol];
			observation[offValueSymbol] = function(updater) {
				offValue.apply(this, arguments);
				var translationHandler = singleReference.getAndDelete(updater, this);

				if (event === "radiochange") {
					canEvent.off.call(el, "change", translationHandler);
				}

				canEvent.off.call(el, event, translationHandler);
			};

		//!steal-remove-start
		Object.defineProperty(get, "name", {
			value: el.nodeName.toLowerCase() + ":" +
				((bindingInfo && bindingInfo.bindingAttributeName) || prop)
		});

		mutateDeps.addMutatedBy(el, prop, observation);

		var obsDeps = canReflect.getValueDependencies(observation);
		observation[canSymbol.for('can.getValueDependencies')] = function() {
			obsDeps = obsDeps == null ? {} : obsDeps;

			if (obsDeps.keyDependencies) {
				var entry = obsDeps.keyDependencies.get(el);
				if (!entry) {
					entry = new Set();
					obsDeps.keyDependencies.set(el, entry);
				}
				entry.add(prop);
			} else {
				obsDeps.keyDependencies = new Map([
					[el, new Set([prop])]
				]);
			}

			return obsDeps;
		};
		//!steal-remove-end

		return observation;
	}
};

// ## bind
// An object with helpers that perform bindings in a certain direction.
// These use the semaphore to prevent cycles.
var bind = {
	// ## bind.childToParent
	// Listens to the child and updates the parent when it changes.
	// - `syncChild` - Makes sure the child is equal to the parent after the parent is set.
	childToParent: function(el, parentObservable, childObservable, bindingsSemaphore, attrName, syncChild, bindingInfo) {
		// Updates the parent if
		function updateParent(newVal) {
			if (!bindingsSemaphore[attrName]) {
				if (parentObservable && parentObservable[getValueSymbol]) {
					var hasDependencies = canReflect.valueHasDependencies(parentObservable);

					if (!hasDependencies || (canReflect.getValue(parentObservable) !== newVal) ) {
						canReflect.setValue(parentObservable, newVal);
					}
					// only sync if parent
					if( syncChild && hasDependencies) {
						// If, after setting the parent, it's value is not the same as the child,
						// update the child with the value of the parent.
						// This is used by `can-value`.
						if(canReflect.getValue(parentObservable) !== canReflect.getValue(childObservable)) {
							bindingsSemaphore[attrName] = (bindingsSemaphore[attrName] || 0) + 1;
							queues.batch.start();
							canReflect.setValue(childObservable, canReflect.getValue(parentObservable));

							queues.mutateQueue.enqueue(function decrementChildToParentSemaphore() {
								--bindingsSemaphore[attrName];
							},null,[],{});
							queues.batch.stop();
						}
					}
				}
				// The parentObservable can sometimes be just an observable if the observable
				// is on a plain JS object. This updates the observable to match whatever the
				// new value is.
				else if(canReflect.isMapLike(parentObservable)) {
					// !steal-dev-start
					var attrValue = el.getAttribute(attrName);
					dev.warn("can-stache-bindings: Merging " + attrName + " into " + attrValue + " because its parent is non-observable");
					// !steal-dev-end
					canReflect.eachKey(parentObservable, function(prop) {
						canReflect.deleteKeyValue(parentObservable, prop);
					});
					canReflect.setValue(
						parentObservable,
						(newVal && newVal.serialize) ? newVal.serialize() : newVal,
						true
					);
				}
			}
		}
		//!steal-remove-start
		Object.defineProperty(updateParent, "name", {
			value: "update "+bindingInfo.parent+"."+bindingInfo.parentName+" of <"+el.nodeName.toLowerCase()+">",
		});
		//!steal-remove-end

		if(childObservable && childObservable[getValueSymbol]) {
			canReflect.onValue(childObservable, updateParent, "domUI");

			//!steal-remove-start
			updateParent[getChangesSymbol] = function() {
				return {
					valueDependencies: new Set([ parentObservable ])
				};
			};
			mutateDeps.addMutatedBy(parentObservable, childObservable);
			//!steal-remove-end
		}

		return updateParent;
	},
	// parent -> child binding
	parentToChild: function(el, parentObservable, childObservable, bindingsSemaphore, attrName, bindingInfo) {
		// setup listening on parent and forwarding to viewModel
		var updateChild = function(newValue) {
			// Save the viewModel property name so it is not updated multiple times.
			// We listen for when the batch has ended, and all observation updates have ended.
			bindingsSemaphore[attrName] = (bindingsSemaphore[attrName] || 0) + 1;
			queues.batch.start();
			canReflect.setValue(childObservable, newValue);

			// only after computes have been updated, reduce the update counter
			queues.mutateQueue.enqueue(function decrementParentToChildSemaphore() {
				--bindingsSemaphore[attrName];
			},null,[],{});
			queues.batch.stop();
		};

		//!steal-remove-start
		Object.defineProperty(updateChild, "name", {
			value: "update "+bindingInfo.child+"."+bindingInfo.childName+" of <"+el.nodeName.toLowerCase()+">",
		});
		//!steal-remove-end

		if(parentObservable && parentObservable[getValueSymbol]) {
			canReflect.onValue(parentObservable, updateChild, "domUI");
			//!steal-remove-start
			mutateDeps.addMutatedBy(childObservable, parentObservable);
			//!steal-remove-end
		}

		return updateChild;
	}
};
var startsWith = String.prototype.startsWith || function(text){
	return this.indexOf(text) === 0;
};

// Gets an event name in the after part.
function getEventName(result) {
	if(result.special.on !== undefined) {
		return result.tokens[result.special.on+1];
	}
}

var bindingRules = {
	to: {
		childToParent: true,
		parentToChild: false,
		syncChildWithParent: false
	},
	from: {
		childToParent: false,
		parentToChild: true,
		syncChildWithParent: false,
	},
	bind: {
		childToParent: true,
		parentToChild: true,
		syncChildWithParent: true,
	}
};
var bindingNames = [];
var special = {
	vm: true,
	on: true
};
each(bindingRules, function(value, key){
	bindingNames.push(key);
	special[key] = true;
});

// "on:click:value:to" //-> {tokens: [...], special: {on: 0, to: 3}}
function tokenize(source) {
	var splitByColon = source.split(":");
	// combine tokens that are not to, from, vm,
	var result = {
		tokens: [],
		special: {}
	};
	splitByColon.forEach(function(token){
		if(special[token]) {
			result.special[token] = result.tokens.push(token) - 1;
		} else {
			result.tokens.push(token);
		}
	});

	return result;
}

// ## getChildBindingStr
var getChildBindingStr = function(tokens, favorViewModel) {
	if (tokens.indexOf('vm') >= 0) {
		return viewModelBindingStr;
	} else if (tokens.indexOf('el') >= 0) {
		return attributeBindingStr;
	} else {
		return favorViewModel ?  viewModelBindingStr: viewModelOrAttributeBindingStr;
	}
};

// ## getBindingInfo
// takes a node object like {name, value} and returns
// an object with information about that binding.
// Properties:
// - `parent` - where is the parentName read from: "scope", "attribute", "viewModel".
// - `parentName` - what is the parent property that should be read.
// - `child` - where is the childName read from: "scope", "attribute", "viewModel".
//  - `childName` - what is the child property that should be read.
// - `parentToChild` - should changes in the parent update the child.
// - `childToParent` - should changes in the child update the parent.
// - `bindingAttributeName` - the attribute name that created this binding.
// - `initializeValues` - should parent and child be initialized to their counterpart.
// If undefined is return, there is no binding.
var getBindingInfo = function(node, attributeViewModelBindings, templateType, tagName, favorViewModel) {
	var bindingInfo,
		attributeName = encoder.decode( node.name ),
		attributeValue = node.value || "";

	// START: check new binding syntaxes ======
	var result = tokenize(attributeName),
		dataBindingName,
		specialIndex;



	// check if there's a match of a binding name with at least a value before it
	bindingNames.forEach(function(name){
		if(result.special[name] !== undefined && result.special[name] > 0) {
			dataBindingName = name;
			specialIndex = result.special[name];
			return false;
		}
	});

	if(dataBindingName) {
		var childEventName = getEventName(result);
		var initializeValues = childEventName ? false : true;
		bindingInfo = assign({
			parent: scopeBindingStr,
			child: getChildBindingStr(result.tokens, favorViewModel),
			// the child is going to be the token before the special location
			childName: result.tokens[specialIndex-1],
			childEvent: childEventName,
			bindingAttributeName: attributeName,
			parentName: attributeValue,
			initializeValues: initializeValues,
		}, bindingRules[dataBindingName]);
		if(attributeValue.trim().charAt(0) === "~") {
			bindingInfo.stickyParentToChild = true;
		}
		return bindingInfo;
	}
	// END: check new binding syntaxes ======

};



// ## makeDataBinding
// Makes a data binding for an attribute `node`.  Returns an object with information
// about the binding, including an `onTeardown` method that undoes the binding.
// If the data binding involves a `viewModel`, an `onCompleteBinding` method is returned on
// the object.  This method must be called after the element has a `viewModel` with the
// `viewModel` to complete the binding.
//
// - `node` - an attribute node or an object with a `name` and `value` property.
// - `el` - the element this binding belongs on.
// - `bindingData` - an object with:
//   - `templateType` - the type of template.
//   - `scope` - the `Scope`,
//   - `semaphore` - an object that keeps track of changes in different properties to prevent cycles,
//   - `getViewModel`  - a function that returns the `viewModel` when called.  This function can be passed around (not called) even if the
//      `viewModel` doesn't exist yet.
//   - `attributeViewModelBindings` - properties already specified as being a viewModel<->attribute (as opposed to viewModel<->scope) binding.
//
// Returns:
// - `undefined` - If this isn't a data binding.
// - `object` - An object with information about the binding.
var makeDataBinding = function(node, el, bindingData) {
	// Get information about the binding.
	var bindingInfo = getBindingInfo(node, bindingData.attributeViewModelBindings,
		bindingData.templateType, el.nodeName.toLowerCase(), bindingData.favorViewModel);
	if(!bindingInfo) {
		return;
	}
	// assign some bindingData props to the bindingInfo
	bindingInfo.alreadyUpdatedChild = bindingData.alreadyUpdatedChild;
	if( bindingData.initializeValues) {
		bindingInfo.initializeValues = true;
	}

	// Get computes for the parent and child binding
	var parentObservable = getObservableFrom[bindingInfo.parent](
		el,
		bindingData.scope,
		bindingInfo.parentName,
		bindingData,
		bindingInfo.parentToChild,
		undefined,
		undefined,
		bindingInfo
	),
	childObservable = getObservableFrom[bindingInfo.child](
		el,
		bindingData.scope,
		bindingInfo.childName,
		bindingData,
		bindingInfo.childToParent,
		bindingInfo.stickyParentToChild && parentObservable,
		bindingInfo.childEvent,
		bindingInfo
	),
	// these are the functions bound to one compute that update the other.
	updateParent,
	updateChild;

	if(bindingData.nodeList) {
		if(parentObservable) {
			canReflect.setPriority(parentObservable, bindingData.nodeList.nesting+1);
		}

		if(childObservable) {
			canReflect.setPriority(childObservable, bindingData.nodeList.nesting+1);
		}
	}

	// Only bind to the parent if it will update the child.
	if(bindingInfo.parentToChild) {
		updateChild = bind.parentToChild(el, parentObservable, childObservable, bindingData.semaphore, bindingInfo.bindingAttributeName, bindingInfo);
	}

	// This completes the binding.  We can't call it right away because
	// the `viewModel` might not have been created yet.
	var completeBinding = function() {
		if(bindingInfo.childToParent) {
			// setup listening on parent and forwarding to viewModel
			updateParent = bind.childToParent(el, parentObservable, childObservable, bindingData.semaphore, bindingInfo.bindingAttributeName,
				bindingInfo.syncChildWithParent, bindingInfo);
		}
		// the child needs to be bound even if
		else if(bindingInfo.stickyParentToChild && childObservable[onValueSymbol])  {
			canReflect.onValue(childObservable, noop,"mutate");
		}

		if(bindingInfo.initializeValues) {
			initializeValues(bindingInfo, childObservable, parentObservable, updateChild, updateParent);
		}
	};

	// This tears down the binding.
	var onTeardown = function() {
		unbindUpdate(parentObservable, updateChild);
		unbindUpdate(childObservable, updateParent);
		unbindUpdate(childObservable, noop);
	};

	// If this binding depends on the viewModel, which might not have been created,
	// return the function to complete the binding as `onCompleteBinding`.
	if(bindingInfo.child === viewModelBindingStr) {
		return {
			value: bindingInfo.stickyParentToChild ? makeCompute(parentObservable) :
				canReflect.getValue(parentObservable),
				onCompleteBinding: completeBinding,
				bindingInfo: bindingInfo,
				onTeardown: onTeardown
		};
	} else {
		completeBinding();
		return {
			bindingInfo: bindingInfo,
			onTeardown: onTeardown
		};
	}
};

// ## initializeValues
// Updates the parent or child value depending on the direction of the binding
// or if the child or parent is `undefined`.
var initializeValues = function(bindingInfo, childObservable, parentObservable, updateChild, updateParent) {
	var doUpdateParent = false;

	if(bindingInfo.parentToChild && !bindingInfo.childToParent) {
		// updateChild
	}
	else if(!bindingInfo.parentToChild && bindingInfo.childToParent) {
		doUpdateParent = true;
	}
	// Two way
	// Update child or parent depending on who has a value.
	// If both have a value, update the child.
	else if(canReflect.getValue(childObservable) === undefined) {
		// updateChild
	} else if(canReflect.getValue(parentObservable) === undefined) {
		doUpdateParent = true;
	}

	if(doUpdateParent) {
		updateParent( canReflect.getValue(childObservable) );
	} else {
		if(!bindingInfo.alreadyUpdatedChild) {
			updateChild( canReflect.getValue(parentObservable) );
		}
	}
};

var unbindUpdate = function(observable, updater) {
	if(observable && observable[getValueSymbol] && typeof updater === "function") {
		canReflect.offValue(observable, updater,"domUI");
	}
},
cleanVMName = function(name) {
	return name.replace(/@/g, "");
};

module.exports = {
	behaviors: behaviors,
	getBindingInfo: getBindingInfo
};
