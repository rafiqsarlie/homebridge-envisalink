var nap = require('nodealarmproxy');
var elink = require('nodealarmproxy/envisalink.js');
var dateFormat = require('dateformat');
var Service, Characteristic, Accessory;
var inherits = require('util').inherits;
var enableSet = true;
var serviceSecurityStateDescription = [
    'STAY_ARM', // 0
    'AWAY_ARM', // 1
    'NIGHT_ARM', // 2
    'DISARMED', // 3
    'ALARM_TRIGGERED' // 4
];

/* Register the plugin with homebridge */
module.exports = function (homebridge) {
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;
    Accessory = homebridge.hap.Accessory;
    uuid = homebridge.hap.uuid;

    var acc = EnvisalinkAccessory.prototype;
    inherits(EnvisalinkAccessory, Accessory);
    EnvisalinkAccessory.prototype.parent = Accessory.prototype;
    for (var mn in acc) {
        EnvisalinkAccessory.prototype[mn] = acc[mn];
    }

    homebridge.registerPlatform("homebridge-envisalink", "Envisalink", EnvisalinkPlatform);
}

function EnvisalinkPlatform(log, config) {
    this.log = log;
    this.platformPartitionAccessories = [];
    this.platformZoneAccessories = [];
    this.platformProgramAccessories = [];

    if (!config || !config.host) {
        this.log("Envisalink plugin is not configured.  Skipping.")
        return;
    }

    this.deviceType = config.deviceType ? config.deviceType : 'DSC';
    this.pin = config.pin;
    this.password = config.password;
    this.partitions = config.partitions ? config.partitions : [{ name: 'Alarm' }];
    this.zones = config.zones ? config.zones : [];
    this.userPrograms = config.userPrograms ? config.userPrograms : [];
    this.enableVerboseLogging = config.enableVerboseLogging ? config.enableVerboseLogging : false;
    this.enableDebugLogging = config.enableDebugLogging ? config.enableDebugLogging : false;

    // over log.info to allow verbose logging to be set in config
    this.log.info = (message, ...params) => {
        if (this.enableVerboseLogging) {
            this.log(message, ...params)
        }
    };

    // debug logging
    this.log.debug = (message, ...params) => {
        if (this.enableDebugLogging) {
            this.log("{}", message, ...params)
        }
    };

    this.log("Configuring Envisalink platform,  Host: " + config.host + ", port: " + config.port + ", type: " + this.deviceType);

    try {
        for (var i = 0; i < this.partitions.length; i++) {
            var partition = this.partitions[i];
            partition.pin = config.pin;
            var accessory = new EnvisalinkAccessory(this.log, "partition", partition, i + 1);
            this.platformPartitionAccessories.push(accessory);
        }
        this.platformZoneAccessoryMap = {};

        /*
        * maxZone variable is very important for two reasons
        * (1) Prevents UUID collisions when userPrograms are initialized
        * (2) This variable tells Node Alarm Proxy the maximum zone number to monitor
        */
        var maxZone = this.zones.length;
        let zoneNumbers = new Set();
        if (!config.suppressZoneAccessories) {
            for (var i = 0; i < this.zones.length; i++) {
                var zone = this.zones[i];
                if (zone.type == "motion" || zone.type == "window" || zone.type == "door" || zone.type == "leak" || zone.type == "smoke") {
                    var zoneNum = zone.zoneNumber ? zone.zoneNumber : (i + 1);
                    if (zoneNum > maxZone) {
                        maxZone = zoneNum;
                    }
                    if (zoneNumbers.has(zoneNum)) {
                        this.log.error(zone.name + " contains a duplicate zoneNumber: " + zoneNum + " and will be ignored.  " +
                            "zoneNumber configs should all be populated if any are specified, and all should be unique.");
                    } else {
                        zoneNumbers.add(zoneNum);
                        var accessory = new EnvisalinkAccessory(this.log, zone.type, zone, zone.partition, zoneNum);
                        var accessoryIndex = this.platformZoneAccessories.push(accessory) - 1;
                        this.platformZoneAccessoryMap['z.' + zoneNum] = accessoryIndex;
                    }
                } else {
                    this.log.error("Unhandled accessory type: " + zone.type);
                }
            }
        }
        this.platformProgramAccessories = [];
        for (var i = 0; i < this.userPrograms.length; i++) {
            var program = this.userPrograms[i];
            if (program.type === "smoke") {
                var accessory = new EnvisalinkAccessory(this.log, program.type, program, program.partition, maxZone + i + 1);
                this.platformProgramAccessories.push(accessory);
            } else {
                this.log.error("Unhandled accessory type: " + program.type);
            }
        }

        this.log("Starting node alarm proxy...");
        this.alarmConfig = {
            password: config.password,
            serverpassword: config.password,
            actualhost: config.host,
            actualport: config.port,
            serverhost: '0.0.0.0',
            serverport: config.serverport ? config.serverport : 4026,
            zone: maxZone > 0 ? maxZone : null,
            userPrograms: this.userPrograms.length > 0 ? this.userPrograms.length : null,
            partition: this.partitions ? this.partitions.length : 1,
            proxyenable: true,
            atomicEvents: true,
            logging: false
        };
        this.log("Zone Config: " + this.alarmConfig.zone);
        this.log("User Program Config: " + this.alarmConfig.userPrograms);
        this.alarm = nap.initConfig(this.alarmConfig);
        this.log("Node alarm proxy started.  Listening for connections at: " + this.alarmConfig.serverhost + ":" + this.alarmConfig.serverport);
        this.alarm.on('data', this.systemUpdate.bind(this));
        this.alarm.on('zoneupdate', this.zoneUpdate.bind(this));
        this.alarm.on('partitionupdate', this.partitionUpdate.bind(this));
        this.alarm.on('partitionuserupdate', this.partitionUserUpdate.bind(this));
        this.alarm.on('systemupdate', this.systemUpdate.bind(this));

        if (!config.suppressClockReset) {
            var nextSetTime = function () {
                this.platformPartitionAccessories[0].addDelayedEvent('time');
                setTimeout(nextSetTime.bind(this), 60 * 60 * 1000);
            }

            setTimeout(nextSetTime.bind(this), 5000);
        }
    } catch (ex) {
        this.log.error("Failed to initialize Envisalink: ", ex);
    }
}

EnvisalinkPlatform.prototype.partitionUserUpdate = function (users) {
    this.log('Partition User Update changed to: ', users);
}

EnvisalinkPlatform.prototype.systemUpdate = function (data) {
    try {

        var systemStatus = data.system;
        if (!systemStatus) {
            systemStatus = data;
        }

        if (systemStatus) {
            for (var i = 0; i < this.platformProgramAccessories.length; i++) {
                var programAccessory = this.platformProgramAccessories[i];
                var accservice = (programAccessory.getServices())[0];
                if (accservice) {
                    var code = systemStatus.code && systemStatus.code.substring(0, 3);
                    if (programAccessory.accessoryType === 'smoke' && code === '631') {
                        accservice.getCharacteristic(Characteristic.SmokeDetected).setValue(Characteristic.SmokeDetected.SMOKE_DETECTED);

                        var partition = this.platformPartitionAccessories[parseInt(programAccessory.partition) - 1];
                        var partitionService = partition && (partition.getServices())[0];
                        partitionService && partitionService.getCharacteristic(Characteristic.SecuritySystemTargetState).getValue(function (context, value) {
                            partitionService.getCharacteristic(Characteristic.SecuritySystemTargetState).setValue(Characteristic.SecuritySystemTargetState.STAY_ARM);
                            partition.currentState = value;
                        });
                    } else if (programAccessory.accessoryType === 'smoke' && code === '632') {
                        accservice.getCharacteristic(Characteristic.SmokeDetected).setValue(Characteristic.SmokeDetected.SMOKE_NOT_DETECTED);
                        var partition = this.platformPartitionAccessories[parseInt(programAccessory.partition) - 1];
                        var partitionService = partition && (partition.getServices())[0];
                        if (partition && partition.currentState !== undefined) {
                            partitionService && partitionService.getCharacteristic(Characteristic.SecuritySystemTargetState).setValue(partition.currentState);
                            delete partition.currentState;
                        }
                    }
                }
            }
        }

        // set state for each open zone
        if (data.zone) {
            for (var i = 0; i < this.platformZoneAccessories.length; i++) {
                var zoneStatus = data.zone['' + (i + 1)];
                if (zoneStatus) {
                    var zoneCode = zoneStatus.code && zoneStatus.code.substring(0, 3);
                    if (zoneCode == '609') { // open zone
                        this.zoneUpdate({
                            zone: (i + 1),
                            code: zoneCode
                        })
                    }
                }
            }
        }

        // set state for each partition
        if (data.partition) {
            for (var i = 0; i < this.platformPartitionAccessories.length; i++) {
                var systemStatus = data.partition['' + (i + 1)];
                if (systemStatus) {
                    this.log.debug('System status' + ':', systemStatus.code);
                    var code = systemStatus.code && systemStatus.code.substring(0, 3);
                    this.partitionUpdate({
                        partition: (i + 1),
                        code: code,
                        mode: (code == '652') && systemStatus.code.substring(4, 5)
                    });
                }
            }
        }
    } catch (ex) {
        this.log.error("Failed handle status change: ", ex);
    }
}

EnvisalinkPlatform.prototype.zoneUpdate = function (data) {
    try {
        var accessoryIndex = this.platformZoneAccessoryMap['z.' + data.zone];
        if (accessoryIndex !== undefined) {
            var accessory = this.platformZoneAccessories[accessoryIndex];
            if (accessory) {
                accessory.status = Object.assign({}, elink.tpicommands[data.code]);
                accessory.status.code = data.code;
                accessory.status.mode = data.mode;
                this.log.info('Set status on zone', accessory.zone, accessory.name, 'to', accessory.status.code, accessory.status.name);

                var accservice = (accessory.getServices())[0];

                if (accservice) {
                    if (accessory.accessoryType == "motion") {

                        accessory.getMotionStatus(function (nothing, resultat) {
                            accservice.getCharacteristic(Characteristic.MotionDetected).setValue(resultat);
                        });

                    } else if (accessory.accessoryType == "door" || accessory.accessoryType == "window") {

                        accessory.getContactSensorState(function (nothing, resultat) {
                            accservice.getCharacteristic(Characteristic.ContactSensorState).setValue(resultat);
                        });

                    } else if (accessory.accessoryType == "leak") {

                        accessory.getLeakStatus(function (nothing, resultat) {
                            accservice.getCharacteristic(Characteristic.LeakDetected).setValue(resultat);
                        });

                    } else if (accessory.accessoryType == "smoke") {

                        accessory.getSmokeStatus(function (nothing, resultat) {
                            accservice.getCharacteristic(Characteristic.SmokeDetected).setValue(resultat);
                        });

                    }
                }
            }
        }
    } catch (ex) {
        this.log.error("Failed to handle zone update: ", ex);
    }
}

EnvisalinkPlatform.prototype.partitionUpdate = function (data) {
    try {
        var watchevents = ['601', '602', '609', '610', '650', '651', '652', '654', '656', '657'];

        var partition = this.platformPartitionAccessories[data.partition - 1];
        if (partition) {
            partition.status = Object.assign({}, elink.tpicommands[data.code]);
            partition.status.code = data.code;
            partition.status.mode = data.mode;
            partition.status.partition = data.partition;

            this.log.debug('Partition', data.partition, 'status :', partition.status.code, partition.status.name,
                (partition.status.code == '652') ? 'mode ' + partition.status.mode : '');

            var accservice = (partition.getServices())[0];

            if (accservice) {
                if (data.code == "656") { //exit delay
                    this.log('Exit delay on', partition.name, '(' + partition.partition + ')');
                } else if (data.code == "657") { //entry-delay
                    this.log('Entry delay on', partition.name, '(' + partition.partition + ')');
                } else if (data.code == "654") { //Alarm
                    partition.log('Alarm state on', partition.name, '(' + partition.partition + ')', 'is', serviceSecurityStateDescription[characteristic.SecuritySystemCurrentState.ALARM_TRIGGERED]);
                    accservice.getCharacteristic(Characteristic.SecuritySystemCurrentState).setValue(Characteristic.SecuritySystemCurrentState.ALARM_TRIGGERED);
                } else if (data.code == "652" || data.code == "655") { //Armed, Disarmed
                    var currentState = partition.getCurrentState();
                    partition.lastTargetState = currentState;
                    partition.log('Alarm state on', partition.name, '(' + partition.partition + ')', 'is', serviceSecurityStateDescription[currentState]);
                    enableSet = false;
                    accservice.getCharacteristic(Characteristic.SecuritySystemTargetState).setValue(currentState);
                    enableSet = true;
                    accservice.getCharacteristic(Characteristic.SecuritySystemCurrentState).setValue(currentState);
                } else if (data.code == "626" || data.code == "650" || data.code == "651" || data.code == "653") { //Ready, Not Ready, Ready Force ARM
                    var self = this;
                    var currentState = partition.getCurrentState();
                    if (partition.lastTargetState == undefined || partition.lastTargetState == "652" || partition.lastTargetState == "655") {
                        partition.log('Alarm state on', partition.name, '(' + partition.partition + ')', 'is', serviceSecurityStateDescription[currentState]);
                    }
                    partition.lastTargetState = currentState;
                    partition.getReadyState(function (nothing, resultat) {
                        self.log.info('Setting obstructed', resultat, 'on', partition.name, '(' + partition.partition + ')');
                        accservice.getCharacteristic(Characteristic.ObstructionDetected).setValue(resultat);
                    });
                }
            }
        }
    } catch (ex) {
        this.log.error("Failed to handle partition update: ", ex);
    }
}

EnvisalinkPlatform.prototype.accessories = function (callback) {
    callback(this.platformPartitionAccessories.concat(this.platformZoneAccessories).concat(this.platformProgramAccessories));
}

function EnvisalinkAccessory(log, accessoryType, config, partition, zone) {
    this.log = log;
    this.name = config.name;
    var id = 'envisalink.' + partition;
    if (zone) {
        id += "." + zone;
    }
    this.uuid_base = uuid.generate(id);
    this.log('Generated UUID ' + this.uuid_base + ' for accessory ID ' + id);
    Accessory.call(this, this.name, this.uuid_base);

    this.accessoryType = accessoryType;
    this.partition = partition;
    this.pin = config.pin;
    this.zone = zone;
    this.status = null;

    this.services = [];
    if (this.accessoryType == "partition") {
        var service = new Service.SecuritySystem(this.name);

        var targetStateCharacteristic = service.getCharacteristic(Characteristic.SecuritySystemTargetState);
        var targetStates = targetStateCharacteristic.props.validValues;

        // XXX disabling night mode
        // TODO must set as config option
        var disabledModes = ['NIGHT_ARM'];
        // var disabledModes = [];
        var disabledTargetStates = [];

        for (let disabledMode of disabledModes) {
            disabledTargetStates.push(serviceSecurityStateDescription.indexOf(disabledMode));
        }

        targetStates = targetStates.filter(i => !disabledTargetStates.includes(i));
        console.log('target states', targetStates);

        service
            .getCharacteristic(Characteristic.SecuritySystemCurrentState)
            .on('get', this.getAlarmCurrentState.bind(this));
        service
            .getCharacteristic(Characteristic.SecuritySystemTargetState)
            .setProps({ validValues: targetStates })
            .on('get', this.getAlarmTargetState.bind(this))
            .on('set', this.setAlarmTargetState.bind(this));
        service
            .addCharacteristic(Characteristic.ObstructionDetected)
            .on('get', this.getReadyState.bind(this));
        this.services.push(service);
    } else if (this.accessoryType == "motion") {
        var service = new Service.MotionSensor(this.name);
        service
            .getCharacteristic(Characteristic.MotionDetected)
            .on('get', this.getMotionStatus.bind(this));
        this.services.push(service);
    } else if (this.accessoryType == "door") {
        var service = new Service.ContactSensor(this.name);
        service
            .getCharacteristic(Characteristic.ContactSensorState)
            .on('get', this.getContactSensorState.bind(this));
        this.services.push(service);
    } else if (this.accessoryType == "window") {
        var service = new Service.ContactSensor(this.name);
        service
            .getCharacteristic(Characteristic.ContactSensorState)
            .on('get', this.getContactSensorState.bind(this));
        this.services.push(service);
    } else if (this.accessoryType == "leak") {
        var service = new Service.LeakSensor(this.name);
        service
            .getCharacteristic(Characteristic.LeakDetected)
            .on('get', this.getLeakStatus.bind(this));
        this.services.push(service);
    } else if (this.accessoryType == "smoke") {
        var service = new Service.SmokeSensor(this.name);
        service
            .getCharacteristic(Characteristic.SmokeDetected)
            .on('get', this.getSmokeStatus.bind(this));
        this.services.push(service);
    }
}

EnvisalinkAccessory.prototype.getServices = function () {
    return this.services;
}

EnvisalinkAccessory.prototype.getMotionStatus = function (callback) {
    if (this.status && this.status.send == "open") {
        callback(null, true);
    } else {
        callback(null, false);
    }
}

EnvisalinkAccessory.prototype.getReadyState = function (callback) {
    var currentState = this.status;
    var status = true;
    if (currentState && currentState.partition === this.partition) {
        if (currentState.send == "ready" || currentState.send == "readyforce") {
            status = false;
        }
    }
    callback(null, status);
}

EnvisalinkAccessory.prototype.getCurrentState = function (status) {
    var state;
    var currentStatus = this.status;

    if (currentStatus) {
        if (currentStatus.send == 'alarm') {
            // 654 Partition in Alarm
            state = Characteristic.SecuritySystemCurrentState.ALARM_TRIGGERED;
        } else if (currentStatus.code == '650' || currentStatus.send == 'disarmed') {
            // 650 Partition Ready, 655 Partition Disarmed, 751 Special Opening
            state = Characteristic.SecuritySystemCurrentState.DISARMED;
        } else if (currentStatus.code == '652') {
            // 652 Partition Armed -- ignoring 700,701, 702 because they do not incl. the stay/away mode
            //0: AWAY, 1: STAY, 2:  ZERO-ENTRY-AWAY, 3:  ZERO-ENTRY-STAY
            if (currentStatus.mode === '1' || currentStatus.mode === '3') {
                state = Characteristic.SecuritySystemCurrentState.STAY_ARM;
            } else {
                state = Characteristic.SecuritySystemCurrentState.AWAY_ARM;
            }
        }
    }
    return state;
}

EnvisalinkAccessory.prototype.getAlarmTargetState = function (callback) {
    this.getAlarmState(true, callback);
}

EnvisalinkAccessory.prototype.getAlarmCurrentState = function (callback) {
    this.getAlarmState(false, callback);
}

EnvisalinkAccessory.prototype.getAlarmState = function (targetStateRequested, callback) {
    //default to last state or set to disarmed if not previously set
    var currentState = this.getCurrentState();

    // target state cannot be alarm triggered so return last state and if not set then return disarmed
    if (targetStateRequested && currentState === Characteristic.SecuritySystemCurrentState.ALARM_TRIGGERED) {
        currentState = undefined;
    }

    // note state_armed == 0 so a conditional will return false for this, instead evaluate state where or not it is undefined
    returnState = (currentState !== undefined ? currentState : (this.lastTargetState !== undefined ? this.lastTargetState : Characteristic.SecuritySystemCurrentState.DISARMED));

    this.log.debug('Alarm', (targetStateRequested ? 'target' : 'current'), 'state', this.partition + ':', returnState, '(current ' + currentState + ', lastTarget ' + this.lastTargetState + ')');
    callback(null, returnState);
}

EnvisalinkAccessory.prototype.setAlarmTargetState = function (state, callback) {
    this.log.debug('Set alarm target state', this.partition + ':', state);
    this.addDelayedEvent('alarm', state, callback);
}

EnvisalinkAccessory.prototype.getContactSensorState = function (callback) {
    if (this.status && this.status.send == "open") {
        callback(null, Characteristic.ContactSensorState.CONTACT_NOT_DETECTED);
    } else {
        callback(null, Characteristic.ContactSensorState.CONTACT_DETECTED);
    }
}

EnvisalinkAccessory.prototype.getLeakStatus = function (callback) {
    if (this.status && this.status.send == "open") {
        callback(null, Characteristic.LeakDetected.LEAK_DETECTED);
    } else {
        callback(null, Characteristic.LeakDetected.LEAK_NOT_DETECTED);
    }
}

EnvisalinkAccessory.prototype.getSmokeStatus = function (callback) {
    if (this.status && this.status.send == "open") {
        callback(null, Characteristic.SmokeDetected.SMOKE_DETECTED);
    } else {
        callback(null, Characteristic.SmokeDetected.SMOKE_NOT_DETECTED);
    }
}

EnvisalinkAccessory.prototype.processAlarmState = function (nextEvent, callback) {
    try {
        if (nextEvent.enableSet == true) {
            if (nextEvent.data !== Characteristic.SecuritySystemCurrentState.DISARMED && this.status && this.status.code === '651') {
                var accservice = this.getServices()[0];
                accservice.getCharacteristic(Characteristic.SecuritySystemTargetState).setValue(Characteristic.SecuritySystemCurrentState.DISARMED);
                nextEvent.callback(null, Characteristic.SecuritySystemCurrentState.DISARMED);
                return;
            }

            this.log("Setting alarm state on", this.name, '(' + this.partition + ')', 'to', serviceSecurityStateDescription[nextEvent.data], '(' + nextEvent.data + ')');
            var command = null;
            if (nextEvent.data == Characteristic.SecuritySystemCurrentState.DISARMED) {
                this.log("Disarming alarm with PIN.");
                command = "040" + this.partition + this.pin;
            } else if (nextEvent.data == Characteristic.SecuritySystemCurrentState.STAY_ARM || nextEvent.data == Characteristic.SecuritySystemCurrentState.NIGHT_ARM) {
                this.log("Arming alarm to Stay/Night.");
                command = "031" + this.partition;
            } else if (nextEvent.data == Characteristic.SecuritySystemCurrentState.AWAY_ARM) {
                this.log("Arming alarm to Away.");
                command = "030" + this.partition;
            }
            if (command) {
                var self = this;
                nap.manualCommand(command, function (msg) {
                    if (msg === '024') {
                        if (nextEvent.attempts > 5) {
                            nextEvent.callback(null);
                            callback();
                            return;
                        }
                        var eventData = {
                            data: nextEvent.data,
                            enableSet: nextEvent.enableSet,
                            attempts: (nextEvent.attempts || 0) + 1
                        };

                        self.insertDelayedEvent('alarm', eventData, nextEvent.callback, 1000);
                    } else {
                        try {
                            nextEvent.callback(null, nextEvent.data);
                            callback();
                        } catch (err) {
                            self.log.error("Error in nextEvent.callback. " + err);
                        }
                    }
                });
            } else {
                this.log("Unhandled alarm state: " + nextEvent.data);
                nextEvent.callback(null);
                callback();
            }
        } else {
            nextEvent.callback(null);
            callback();
        }
    } catch (ex) {
        this.log.error("Failed to process alarm state: ", ex);
    }
}

EnvisalinkAccessory.prototype.processTimeChange = function (nextEvent, callback) {
    try {
        var self = this;
        var date = dateFormat(new Date(), "HHMMmmddyy");
        this.log("Setting the current time on the alarm system to: " + date);
        nap.manualCommand("010" + date, function (data) {
            if (data) {
                self.log("Time not set successfully.");
            } else {
                self.log("Time set successfully.");
            }

            callback();

        }.bind(self));
    } catch (ex) {
        this.log.error("Failed to process time change: ", ex);
    }
}

EnvisalinkAccessory.prototype.insertDelayedEvent = function (type, data, callback, delay, pushEndBool) {
    try {
        var eventData;
        if (typeof data === 'object') {
            eventData = data;
            eventData.type = type;
            eventData.callback = callback;
        } else {
            eventData = {
                id: Math.floor((Math.random() * 10000) + 1),
                type: type,
                data: data,
                enableSet: enableSet,
                callback: callback
            };
        }

        if (pushEndBool) {
            this.delayedEvents = this.delayedEvents || [];
            this.delayedEvents.push(eventData);
        } else {
            this.delayedEvents = [eventData].concat(this.delayedEvents || []);
        }

        if (this.delayedEvents.length === 1) {
            setTimeout(this.processDelayedEvents.bind(this), delay || 0);
        }
    } catch (ex) {
        this.log.error("Failed to insert delayed event: ", ex);
    }
}

EnvisalinkAccessory.prototype.addDelayedEvent = function (type, data, callback, delay) {
    this.insertDelayedEvent.call(this, type, data, callback, delay, true);
}

EnvisalinkAccessory.prototype.processDelayedEvents = function () {
    try {
        if (this.delayedEvents && this.delayedEvents.length > 0) {
            var nextEvent = this.delayedEvents[0];
            this.delayedEvents = this.delayedEvents.slice(1);
            var callback = function () {
                if (this.delayedEvents.length > 0) {
                    setTimeout(this.processDelayedEvents.bind(this), 0);
                }
            };
            if (nextEvent.type === 'alarm') {
                this.processAlarmState(nextEvent, callback.bind(this));
            } else if (nextEvent.type === 'time') {
                this.processTimeChange(nextEvent, callback.bind(this));
            }
        }
    } catch (ex) {
        this.log.error("Failed to process delayed event: ", ex);
    }
}
