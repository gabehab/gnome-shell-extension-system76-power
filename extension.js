const Clutter = imports.gi.Clutter;
const Gio = imports.gi.Gio;
const St = imports.gi.St;
const Lang = imports.lang;
const Pango = imports.gi.Pango;
const Util = imports.misc.util;
const ByteArray = imports.byteArray;

const Dialog = imports.ui.dialog;
const Main = imports.ui.main;
const ModalDialog = imports.ui.modalDialog;
const PopupMenu = imports.ui.popupMenu;
const Ornament = imports.ui.popupMenu.Ornament;

const PowerDaemon = Gio.DBusProxy.makeProxyWrapper(
'<node>\
  <interface name="com.system76.PowerDaemon">\
    <method name="Performance"/>\
    <method name="Balanced"/>\
    <method name="Battery"/>\
    <method name="GetProfile">\
        <arg name="profile" type="s" direction="out"/>\
    </method>\
    <method name="GetGraphics">\
      <arg name="vendor" type="s" direction="out"/>\
    </method>\
    <method name="SetGraphics">\
      <arg name="vendor" type="s" direction="in"/>\
    </method>\
    <method name="GetSwitchable">\
      <arg name="switchable" type="b" direction="out"/>\
    </method>\
    <method name="GetGraphicsPower">\
      <arg name="power" type="b" direction="out"/>\
    </method>\
    <method name="SetGraphicsPower">\
      <arg name="power" type="b" direction="in"/>\
    </method>\
    <method name="AutoGraphicsPower"/>\
    <signal name="HotPlugDetect">\
      <arg name="port" type="t"/>\
    </signal>\
    <signal name="PowerProfileSwitch">\
      <arg name="profile" type="s"/>\
    </signal>\
  </interface>\
</node>'
);

const GRAPHICS = _(" Graphics");

const DMI_PRODUCT_VERSION_PATH = "/sys/class/dmi/id/product_version";
const DISCRETE_EXTERNAL_DISPLAY_MODELS = [
    "addw1",
    "oryp4",
    "oryp4-b",
    "oryp5"
];
var DISPLAY_REQUIRES_NVIDIA = false;

function log(text) {
    global.log("gnome-shell-extension-system76-power: " + text);
}

function init() {
    var file = Gio.File.new_for_path(DMI_PRODUCT_VERSION_PATH);
    var [success, contents] = file.load_contents(null);
    var product_version = ByteArray.toString(contents).trim();
    DISPLAY_REQUIRES_NVIDIA = DISCRETE_EXTERNAL_DISPLAY_MODELS.includes(product_version);
}

var switched = false;
var notified = false;

var textProps = { ellipsize_mode: Pango.EllipsizeMode.NONE,
                  line_wrap: true };

var PopDialog = class PopDialog extends ModalDialog.ModalDialog {
    constructor(icon_name, title, body, params) {
        super(params);

        let icon = new Gio.ThemedIcon({ name: icon_name });
        this._content = new Dialog.MessageDialogContent({ icon, title, body });
        this.contentLayout.add(this._content);
    }
};

var PopupGraphicsMenuItem = class PopupGraphicsMenuItem extends PopupMenu.PopupBaseMenuItem {
  constructor(title, text, params) {
    super(params);

    this.box = new St.BoxLayout({ vertical: true });
    this.label = new St.Label({
        style_class: "pop-menu-title",
        text: title,
    });

    this.description = new St.Label({
        style_class: "pop-menu-description",
        text: "",
    });

    if (text != null) {
       this.description.text = text;
    } else {
       this.description.hide();
    }

    this.box.add_child(this.label);
    this.box.add_child(this.description);
    this.actor.add_child(this.box);
    this.actor.label_actor = this.box;
  }
};

function set_power_profile(active_profile) {
    this.reset_profile_ornament();

    if (active_profile == "Battery") {
        this.battery.setOrnament(Ornament.DOT);
    } else if (active_profile == "Balanced") {
        this.balanced.setOrnament(Ornament.DOT);
    } else if (active_profile == "Performance") {
        this.performance.setOrnament(Ornament.DOT);
    }

    log("power profile was set: '" + active_profile + "'");
}

function enable() {
    this.bus = new PowerDaemon(Gio.DBus.system, 'com.system76.PowerDaemon', '/com/system76/PowerDaemon');

    this.powerMenu = Main.panel.statusArea['aggregateMenu']._power._item.menu;

    try {
        if (this.bus.GetSwitchableSync() == "true") {
            var graphics = this.bus.GetGraphicsSync();

            this.graphics_separator = new PopupMenu.PopupSeparatorMenuItem();
            this.powerMenu.addMenuItem(this.graphics_separator, 0);

            var intel_text, nvidia_text;
            if (DISPLAY_REQUIRES_NVIDIA) {
                if (graphics == "intel") {
                    intel_text = null;
                    nvidia_text = _("Enable for external displays.\nRequires restart.");
                } else {
                    intel_text = _("Disables external displays.\nRequires restart.");
                    nvidia_text = null;
                }
            } else if (graphics == "intel") {
                intel_text = null;
                nvidia_text = _("Requires restart.");
            } else {
                intel_text = _("Requires restart.");
                nvidia_text = null;
            }

            var intel_name = "Intel";
            this.intel = new PopupGraphicsMenuItem(intel_name + GRAPHICS, intel_text);
            this.intel.setting = false;
            this.intel.connect('activate', (item, event) => {
                this.graphics_activate(item, intel_name, "intel");
            });
            this.powerMenu.addMenuItem(this.intel, 0);

            var nvidia_name = "NVIDIA";
            this.nvidia = new PopupGraphicsMenuItem(nvidia_name + GRAPHICS, nvidia_text);
            this.nvidia.setting = false;
            this.nvidia.connect('activate', (item, event) => {
                this.graphics_activate(item, nvidia_name, "nvidia");
            });
            this.powerMenu.addMenuItem(this.nvidia, 0);

            this.reset_graphics_ornament();
            if (graphics == "intel") {
                this.intel.setOrnament(Ornament.DOT);
            } else if (graphics == "nvidia") {
                this.nvidia.setOrnament(Ornament.DOT);
            }

            var extension = this;
            this.bus.connectSignal("HotPlugDetect", function (proxy) {
                log("hotplug event detected");
                var graphics = proxy.GetGraphicsSync();
                if (graphics != "nvidia") {
                    extension.hotplug(extension.nvidia, nvidia_name, "nvidia");
                }
            });
        }
    } catch (error) {
        log("failed to detect graphics switching: " + error);
    }

    this.profile_separator = new PopupMenu.PopupSeparatorMenuItem();
    this.powerMenu.addMenuItem(this.profile_separator, 0);

    this.battery = new PopupMenu.PopupMenuItem(_("Battery Life"));
    this.battery.connect('activate', (item, event) => {
        this.reset_profile_ornament();
        this.bus.BatteryRemote(function() {
            item.setOrnament(Ornament.DOT);
        });
    });
    this.powerMenu.addMenuItem(this.battery, 0);

    this.balanced = new PopupMenu.PopupMenuItem(_("Balanced"));
    this.balanced.connect('activate', (item, event) => {
        this.reset_profile_ornament();
        this.bus.BalancedRemote(function() {
            item.setOrnament(Ornament.DOT);
        });
    });
    this.powerMenu.addMenuItem(this.balanced, 0);

    this.performance = new PopupMenu.PopupMenuItem(_("High Performance"));
    this.performance.connect('activate', (item, event) => {
        this.reset_profile_ornament();
        this.bus.PerformanceRemote(function() {
            item.setOrnament(Ornament.DOT);
        });
    });
    this.powerMenu.addMenuItem(this.performance, 0);

    var extension = this;
    extension.set_power_profile(this.bus.GetProfileSync());
    this.bus.connectSignal("PowerProfileSwitch", function (proxy, sender, [profile]) {
        extension.set_power_profile(profile);
    });
}

function hotplug(item, name, vendor) {
    var extension = this;
    if (switched || notified) {
      return;
    }

    notified = true;
    var dialog = new PopDialog(
        "video-display-symbolic",
        _("Switch to ") + name + _(" to use external displays"),
        _("External displays are connected to the NVIDIA card. Switch to NVIDIA graphics to use them."),
    );
    dialog.open();

    var alternative_graphics;
    if (name == "NVIDIA") {
        alternative_graphics = "Intel";
    } else {
        alternative_graphics = "NVIDIA";
    }

    dialog.setButtons([{
        action: function() {
            dialog.close();
        },
        label: _("Continue using ") + alternative_graphics,
        key: Clutter.Escape
    }, {
        action: function() {
            dialog.close();
            extension.graphics_activate(item, name, vendor);
        },
        label: _("Switch to ") + name,
        key: Clutter.Enter
    }]);
}

function graphics_activate(item, name, vendor) {
    switched = true;
    var extension = this;
    if (!item.setting) {
        item.setting = true;

        var dialog = new PopDialog(
            "dialog-warning-symbolic",
            _("Preparing to Switch to ") + name + GRAPHICS,
            name + _(" graphics will be enabled on the next restart"),
        );
        dialog.open();

        extension.bus.SetGraphicsRemote(vendor, function(result, error) {
            item.setting = false;

            if (error == null) {
                dialog._content._icon.icon_name = "system-restart-symbolic";
                dialog._content._title.set_text(_("Restart to Switch to ") + name + GRAPHICS);
                dialog._content._body.set_text(_("Switching to ") + name + _(" will close all open apps and restart your device. You may lose any unsaved work."));

                var reboot_msg = _("Will be enabled on\nthe next restart.");
                if (name == "intel") {
                    extension.intel.description.text = reboot_msg;
                    extension.intel.description.show();

                    extension.nvidia.description.hide();
                } else {
                    extension.nvidia.description.text = reboot_msg;
                    extension.nvidia.description.show();

                    extension.intel.description.hide();
                }

                dialog.setButtons([{
                    action: function() {
                        dialog.close();
                    },
                    label: _("Restart Later"),
                    key: Clutter.Escape
                }, {
                    action: function() {
                        dialog.close();
                        extension.reboot();
                    },
                    label: _("Restart and Switch"),
                    key: Clutter.Enter
                }]);
            } else {
                log("failed to switch: " + error);

                dialog._content._icon.icon_name = "dialog-warning-symbolic";
                dialog._content._title.set_text(_("Failed to switch to ") + name);
                dialog._content._body.set_text("");

                dialog.setButtons([{
                    action: function() {
                        dialog.close();
                    },
                    label: "Close",
                    key: Clutter.Escape
                }]);
            }
        });
    }
}

function reboot(name) {
    Util.trySpawn(["systemctl", "reboot"]);
}

function reset_graphics_ornament() {
    this.nvidia.setOrnament(Ornament.NONE);
    this.intel.setOrnament(Ornament.NONE);
}

function reset_profile_ornament() {
    this.performance.setOrnament(Ornament.NONE);
    this.balanced.setOrnament(Ornament.NONE);
    this.battery.setOrnament(Ornament.NONE);
}

function disable() {
    if (this.performance) {
        this.performance.destroy();
        this.performance = null;
    }

    if (this.balanced) {
        this.balanced.destroy();
        this.balanced = null;
    }

    if (this.battery) {
        this.battery.destroy();
        this.battery = null;
    }

    if (this.profile_separator) {
        this.profile_separator.destroy();
        this.profile_separator = null;
    }

    if (this.nvidia) {
        this.nvidia.destroy();
        this.nvidia = null;
    }

    if (this.intel) {
        this.intel.destroy();
        this.intel = null;
    }

    if (this.graphics_separator) {
        this.graphics_separator.destroy();
        this.graphics_separator = null;
    }

    if (this.bus) {
        this.bus = null;
    }
}
