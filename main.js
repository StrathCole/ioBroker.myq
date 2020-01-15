'use strict';

const utils = require('@iobroker/adapter-core'); // Get common adapter utils
const myq = require('./lib/myq');

const adapterName = require('./package.json').name.split('.').pop();

const deviceAttributes = {
	online: {
		sect: 'info',
		name: 'Device is online',
		type: 'boolean',
		role: 'indicator'
	},
	desc: {
		sect: 'info',
		name: 'Device name',
		type: 'string',
		role: 'text'
	},
	doorstate: {
		sect: 'states',
		name: 'Door state',
		type: 'number',
		role: 'value.door',
		states: {
			'1': 'open',
			'2': 'closed',
			'3': 'stopped',
			'4': 'opening',
			'5': 'closing',
			'8': 'moving',
			'9': 'not closed'
		}
	},
	addedtime: {
		sect: 'info',
		name: 'Added at',
		type: 'number',
		role: 'date'
	},
	isunattendedopenallowed: {
		sect: 'info',
		name: 'Allow unattended open',
		type: 'boolean',
		role: 'indicator'
	},
	isunattendedcloseallowed: {
		sect: 'info',
		name: 'Allow unattended close',
		type: 'boolean',
		role: 'indicator'
	},
	name: {
		sect: 'info',
		name: 'DeviceName',
		type: 'string',
		role: 'text'
	},
	is_gdo_lock_connected: {
		sect: 'info',
		name: 'GDO lock connected',
		type: 'boolean',
		role: 'indicator'
	},
	attached_work_light_error_present: {
		sect: 'info',
		name: 'Work light error',
		type: 'boolean',
		role: 'indicator.error'
	},
	learnmodestate: {
		sect: 'states',
		name: 'Learn mode',
		type: 'boolean',
		role: 'indicator'
	},
	numdevices: {
		sect: 'info',
		name: 'Connected devices',
		type: 'number',
		role: 'value.info'
	},
	fwver: {
		sect: 'info',
		name: 'Firmware version',
		type: 'string',
		role: 'text'
	},
	IsFirmwareCurrent: {
		sect: 'states',
		name: 'Firmware up to date',
		type: 'boolean',
		role: 'indicator'
	},
	ishomekitcapable: {
		sect: 'states',
		name: 'Homekit capable',
		type: 'boolean',
		role: 'indicator'
	},
	ishomekitactive: {
		sect: 'states',
		name: 'Homekit active',
		type: 'boolean',
		role: 'indicator'
	}
};

function createOrSetState(id, setobj, setval) {
	adapter.getObject(id, function(err, obj) {
		if(err || !obj) {
			adapter.setObject(id, setobj, function() {
				adapter.setState(id, setval, true);
			});
		} else {
			adapter.setState(id, setval, true);
		}
	});
}

function setOrUpdateState(id, name, setval, setunit, settype, setrole, setstates) {
        if(!setunit) {
                setunit = '';
        }
        if(!settype) {
                settype = 'number';
        }
        if(!setrole) {
                setrole = 'value';
        }
        
		let read = true;
		let write = false;
		if(setrole.substr(0, 6) === 'button') {
			read = false;
			write = true;
		} else if(setrole.substr(0, 5) === 'level' || setrole.substr(0, 6) === 'switch') {
			read = true;
			write = true;
		}
		
        let obj = {
                type: 'state',
                common: {
                        name: name,
                        type: settype,
                        role: setrole,
                        read: read,
                        write: write,
                        unit: setunit
                },
                native: {}
        };
		if(setstates && setstates.length > 0) {
			obj.common['states'] = setstates;
		}
        createOrSetState(id, obj, setval);
}

function setOrUpdateObject(id, name, settype, callback) {
	if(!settype) {
		settype = 'channel';
	}
	
	let obj = {
		type: settype,
		common: {
			name: name
		},
		native: {}
	};
	
	adapter.getObject(id, function(err, obj) {
		if(!err && obj) {
			adapter.extendObject(id, obj, function() {
				return callback && callback();
			});
		} else {
			adapter.setObject(id, obj, function() {
				return callback && callback();
			});
		}
	});
}

let adapter;
var deviceUsername;
var devicePassword;

let bigPolling;
let polling;
let pollingTime;
let controller;

function startAdapter(options) {
	options = options || {};
	Object.assign(options, {
		name: 'myq'
	});

	adapter = new utils.Adapter(options);

	adapter.on('unload', function(callback) {
		if(polling) {
			clearTimeout(polling);
		}
		if(bigPolling) {
			clearTimeout(bigPolling);
		}
		controller.logout(function (err, data) {
			adapter.setState('info.connection', false, true);
            callback();
        });
	});

	adapter.on('stateChange', function(id, state) {
		// Warning, state can be null if it was deleted
		try {
			adapter.log.debug('stateChange ' + id + ' ' + JSON.stringify(state));

			if(!id) {
				return;
			}
			
			if(state && id.substr(0, adapter.namespace.length + 1) !== adapter.namespace + '.') {
				processStateChangeForeign(id, state);
				return;
			}
			id = id.substring(adapter.namespace.length + 1); // remove instance name and id
			
			if(state && state.ack) {
				processStateChangeAck(id, state);
				return;
			}
			
			state = state.val;
			adapter.log.debug("id=" + id);
			
			if('undefined' !== typeof state && null !== state) {
				processStateChange(id, state);
			}
		} catch(e) {
			adapter.log.info("Error processing stateChange: " + e);
		}
	});

	adapter.on('message', function(obj) {
		if(typeof obj === 'object' && obj.message) {
			if(obj.command === 'send') {
				adapter.log.debug('send command');

				if(obj.callback) {
					adapter.sendTo(obj.from, obj.command, 'Message received', obj.callback);
				}
			}
		}
	});

	adapter.on('ready', function() {
		if(!adapter.config.username) {
			adapter.log.warn('[START] Username not set');
		} else if(!adapter.config.password) {
			adapter.log.warn('[START] Password not set');
		} else {
			adapter.log.info('[START] Starting MyQ adapter');
			adapter.getForeignObject('system.config', (err, obj) => {
				if (obj && obj.native && obj.native.secret) {
					//noinspection JSUnresolvedVariable
					adapter.config.password = decrypt(obj.native.secret, adapter.config.password);
				} else {
					//noinspection JSUnresolvedVariable
					adapter.config.password = decrypt('Zgfr56gFe87jJOM', adapter.config.password);
				}
				
				main();
			});
		}
	});

	return adapter;
}


function main() {
	deviceUsername = adapter.config.username;
	devicePassword = adapter.config.password;

	pollingTime = adapter.config.pollinterval || 100000;
	if(pollingTime < 5000) {
		pollingTime = 5000;
	}
	
	adapter.log.info('[INFO] Configured polling interval: ' + pollingTime);
	adapter.log.debug('[START] Started Adapter');

	adapter.subscribeStates('*');
	
	setOrUpdateState('update', 'Update device states', false, '', 'boolean', 'button.refresh');
	
	controller = new myq.MyQ(deviceUsername, devicePassword, adapter);
	
	controller.login(function(err, obj) {
		if(!err) {
			pollStates();
		}
	});
}

function pollStates() {
	adapter.log.debug('Starting state polling');
	if(polling) {
		clearTimeout(polling);
		polling = null;
	}
	
	setOrUpdateObject('devices', 'Devices', 'channel', function() {
		controller.getDevices(function(err, obj) {
			if(err || !obj.devices) {
				adapter.log.warn('Failed getting devices: ' + JSON.stringify(obj));
				return;
			}
			
			processDeviceStates(obj.devices);
		});
	});
	
	polling = setTimeout(function() {
		pollStates();
	}, pollingTime);
}

function processDeviceStates(devices) {
	for(let i = 0; i < devices.length; i++) {
		processDeviceState(devices[i]);
	}
}

function getMyQDeviceAttribute(device, key) {
	if(!device || !device.Attributes || !device.Attributes.length) {
		return null;
	}
	
	let attr;
	for(let i = 0; i < device.Attributes.length; i++) {
		attr = device.Attributes[i];
		if(!attr.AttributeDisplayName) {
			continue;
		} else if(attr.AttributeDisplayName === key) {
			return {
				value: attr.Value,
				updated: attr.UpdatedTime
			};
		}
	}
	return null;
}

function processDeviceState(device) {
	// create or update base device obj
	if(!device.MyQDeviceId) {
		adapter.log.warn('Device has no MyQDeviceId');
		adapter.log.debug(JSON.stringify(device));
		return;
	}
	let objId = 'devices.' + device.MyQDeviceId;
	let objName = getMyQDeviceAttribute(device, 'desc');
	if(!objName || !objName.value) {
		objName = {
			value: objId
		};
	}
	setOrUpdateObject(objId, objName.value, 'device', function() {
		// process attributes
		if(device.RegistrationDateTime) {
			setOrUpdateState(objId + '.info.RegistrationDateTime', 'RegistrationDateTime', (new Date(device.RegistrationDateTime)).getTime(), '', 'number', 'date');
		}
		setOrUpdateState(objId + '.info.MyQDeviceTypeId', 'MyQ device type', device.MyQDeviceTypeId, '', 'string', 'text');
		setOrUpdateState(objId + '.info.MyQDeviceTypeName', 'MyQ device type', device.MyQDeviceTypeName, '', 'string', 'text');
		setOrUpdateState(objId + '.info.SerialNumber', 'Serial number', device.SerialNumber, '', 'string', 'text');
		setOrUpdateState(objId + '.info.UpdatedDate', 'Last update time', (new Date(device.UpdatedDate)).getTime(), '', 'number', 'date');
		
		let doorState = getMyQDeviceAttribute(device, 'doorstate');
		if(null !== doorState) {
			setOrUpdateState(objId + '.states.working', 'Door moving', (doorState == '4' || doorState == '5' || doorState == '8' ? true : false), 'boolean', 'indicator.working');
			setOrUpdateState(objId + '.commands.open', 'Open door', false, 'boolean', 'button.open');
			setOrUpdateState(objId + '.commands.close', 'Close door', false, 'boolean', 'button.close');
		} else if(null !== getMyQDeviceAttribute(device, 'lightstate')) {
			setOrUpdateState(objId + '.commands.on', 'Switch on', false, 'boolean', 'button.on');
			setOrUpdateState(objId + '.commands.off', 'Switch off', false, 'boolean', 'button.off');
		}
		
		let attr;
		let attrValue;
		for(let attrId in deviceAttributes) {
			attr = deviceAttributes[attrId];
			attrValue = getMyQDeviceAttribute(device, attrId);
			if(null !== attrValue) {
				if(attrValue.toLowerCase() === 'true' || (attr['type'] === 'boolean' && attrValue == '1')) {
					attrValue = true;
				} else if(attrValue.toLowerCase() === 'false' || (attr['type'] === 'boolean' && attrValue == '0')) {
					attrValue = false;
				} else if(attr['role'] === 'date') {
					attrValue = (new Date(attrValue)).getTime();
				}
				
				if(!attr['states']) {
					attr['states'] = null;
				}
				// attribute exists
				setOrUpdateState(objId + '.' + attr['sect'] + '.' + attrId, attr['name'], attrValue, attr['type'], attr['role'], attr['states']);
			}
		}
	});
}

function processStateChangeAck(id, state) {
	// not yet
}

function processStateChangeForeign(id, state) {
	// not yet
}

function processStateChange(id, value) {
	adapter.log.debug('StateChange: ' + JSON.stringify([id, value]));
	
	if(id.match(/\.commands\.(open|close)$/)) {
		let matches = id.match('/^devices\.([^\.]+)\..*\.(open|close)$/');
		if(!matches) {
			adapter.log.warn('Could not process state id ' + id);
			return;
		}
		
		let deviceId = matches[1];
		let cmd = matches[2];
		if(!deviceId) {
			adapter.log.warn('Found no valid device id in state ' + id);
			return;
		}
		controller.changeDoorState(deviceId, cmd, function(err, obj) {
			if(err) {
				adapter.log.warn('Failed ' + cmd + ' door ' + deviceId + ': ' + JSON.stringify(obj));
				return;
			}
			adapter.setState(id, false, true);
		});
	} else if(id.match(/\.commands\.(on|off)$/)) {
		let matches = id.match('/^devices\.([^\.]+)\..*\.(on|off)$/');
		if(!matches) {
			adapter.log.warn('Could not process state id ' + id);
			return;
		}
		
		let deviceId = matches[1];
		let cmd = matches[2];
		if(!deviceId) {
			adapter.log.warn('Found no valid device id in state ' + id);
			return;
		}
		controller.changeLampState(deviceId, cmd, function(err, obj) {
			if(err) {
				adapter.log.warn('Failed switch ' + cmd + ' lamp ' + deviceId + ': ' + JSON.stringify(obj));
				return;
			}
			adapter.setState(id, false, true);
		});
	}

	return;
}

function decrypt(key, value) {
	var result = '';
	for(var i = 0; i < value.length; ++i) {
			result += String.fromCharCode(key[i % key.length].charCodeAt(0) ^ value.charCodeAt(i));
	}
	return result;
}


// If started as allInOne/compact mode => return function to create instance
if(module && module.parent) {
	module.exports = startAdapter;
} else {
	// or start the instance directly
	startAdapter();
} // endElse