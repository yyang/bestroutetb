var path = require('path');
var fs = require('fs');

function $define(object, prototype) {
  var setterGetterPattern = /^(set|get)([A-Z])(.*)/;
  var setterGetters = {};
  for (var key in prototype) {
    var matches = setterGetterPattern.exec(key)
    if (matches) {
      var name = matches[2].toLowerCase() + matches[3];
      if (!setterGetters.hasOwnProperty(name))
        setterGetters[name] = {};
      setterGetters[name][matches[1]] = prototype[key];
    }
    Object.defineProperty(object, key, {
      value: prototype[key],
      writeable: false
    });
  }
  Object.defineProperties(object, setterGetters);
}
function $declare(object, prototype) {
  object.prototype.constructor = object;
  $define(object.prototype, prototype);
}
function $inherit(type, parent, proto) {
  type.prototype = {
    constructor: type,
    __proto__: parent.prototype
  };
  if (proto) $define(type.prototype, proto);
}

$define(global, {
  $define: $define,
  $declare: $declare,
  $inherit: $inherit
});

function toIPv4(v) {
  var parts = [];
  for (var i = 24; i >= 0; i -= 8)
    parts.push((v >>> i) & 0xff);
  return parts.join('.');
}

function parseIPv4(ip) {
  return ip.split('.').reduce(function(lhv, rhv) {
    return (lhv << 8) | parseInt(rhv, 10);
  }, 0);
}

function getMaskLength(mask) {
  mask = ~mask;
  var n = 32;
  if (mask & 0xffff0000) n -= 16, mask >>>= 16;
  if (mask & 0xff00) n -= 8, mask >>= 8;
  if (mask & 0xf0) n -= 4, mask >>= 4;
  if (mask & 0xc) n -= 2, mask >>= 2;
  if (mask & 0x2) n--, mask >>= 1;
  if (mask) n--;
  return n;
}

function Prefix(prefix, mask) {
  if (prefix instanceof Prefix)
    return prefix.clone();
  if (mask === undefined) {
    prefix = prefix || '';
    this.prefix = parseInt(prefix, 2) << (32 - prefix.length);
    this.length = prefix.length;
  } else {
    this.prefix = parseIPv4(prefix);
    this.length = typeof mask === 'number' ? mask : getMaskLength(parseIPv4(mask));
  }
}
$declare(Prefix, {
  toString: function() {
    if (this.length < 31) {
      var padded = (this.prefix >>> (32 - this.length)) | (1 << this.length);
      return padded.toString(2).substr(1);
    }
    var paddedHi = (this.prefix >>> 16) | (1 << 16);
    var paddedLo = ((this.prefix & 0xffff) >> (32 - this.length)) | (1 << (this.length - 16));
    return paddedHi.toString(2).substr(1) + paddedLo.toString(2).substr(1);
  },
  toIPv4: function() {
    return toIPv4(this.prefix);
  },
  toMask: function() {
    return toIPv4(this.mask);
  },
  append: function(bit) {
    console.assert(this.length < 32);
    this.length++;
    this.prefix |= bit << (32 - this.length);
    return this;
  },
  pop: function() {
    console.assert(this.length > 0);
    this.prefix &= ~(1 << (32 - this.length));
    this.length--;
    return this;
  },
  get: function(index) {
    if (this.prefix & (0x80000000 >>> index))
      return 1;
    return 0;
  },
  clone: function() {
    var p = new Prefix();
    p.length = this.length;
    p.prefix = this.prefix;
    return p;
  },
  getMask: function() {
    if (this.length === 0)
      return 0;
    return 0x80000000 >> (this.length - 1);
  },
  getSize: function() {
    return 1 << (32 - this.length);
  }
});

function RouteTable() {
  this.table = [];
  for (var i = 0; i <= 32; i++)
    this.table.push({});
}
$declare(RouteTable, {
  add: function(ip, netmask, gateway) {
    var maskLength = getMaskLength(parseIPv4(netmask));
    console.assert(maskLength >= 0);
    this.table[maskLength][parseIPv4(ip)] = gateway;
  },
  route: function(ip) {
    ip = parseIPv4(ip);
    for (var i = 32; i > 0; i--) {
      var maskedIp = ip & (0xffffffff << (32 - i));
      if (this.table[i].hasOwnProperty(maskedIp))
        return this.table[i][maskedIp];
    }
    if (this.table[0].hasOwnProperty(0))
      return this.table[0][0];
    return null;
  }
});

function TreeNode(prefix) {
  this.prefix = prefix || new Prefix();
  this.count = [0, 0];
  this.children = [null, null];
}
$declare(TreeNode, {
  append: function(prefix) {
    if (prefix.color === undefined)
      return;
    var node = this;
    for (var i = 0; i < prefix.length; i++) {
      node.count[prefix.color]++;
      var bit = prefix.get(i);
      if (!node.children[bit])
        node.children[bit] = new this.constructor(
            node.prefix.clone().append(bit));
      node = node.children[bit];
    }
    node.color = prefix.color;
  }
});
$define(global, {
  kBlank: -1,
  kRed: 0,
  kBlue: 1
});

var opts = {};
for (var i = 0, argv = process.argv.slice(2); i < argv.length; i++) {
  if (argv[i].substr(0, 2) === '--') {
    var parts = argv[i].substr(2).split('=');
    if (parts.length > 1)
      opts[parts[0]] = parts[1]
    else
      opts[parts[0]] = argv[++i];
  } else {
    opts._ = argv[i];
  }
}

function getAPNICDelegation() {
  return fs.readFileSync(path.dirname(module.filename) + '/delegated-apnic-latest.dat')
      .toString()
      .split('\n')
      .filter(function(v) {
        return /^apnic\|[A-Z]{2}\|ipv4\|\d/.test(v);
      }).map(function(v) {
        var desc = v.split('|');
        var mask = getMaskLength(~(parseInt(desc[4], 10) - 1));
        var prefix = new Prefix(desc[3], mask);
        prefix.country = desc[1];
        return prefix;
      });
}

function getNonAPNICDelegation() {
  return fs.readFileSync(path.dirname(module.filename) + '/ipv4-address-space.dat')
      .toString()
      .split('\n')
      .filter(function(line) {
        return /^\s+\d{3}\/\d.+(?:ALLOCATED|LEGACY)/.test(line) && !/APNIC/.test(line);
      }).map(function(line) {
        var match = /\s+(\d{3})\/(\d)\s+(.+)\d{4}-\d{2}.+(ALLOCATED|LEGACY)/.exec(line);
        var prefix = new Prefix(match[1] + '.0.0.0', parseInt(match[2]));
        prefix.admin = match[3].trim();
        prefix.status = match[4].toLowerCase();
        return prefix;
      });
}

function I18nStrings(data, locales) {
  this.data = data;
  this.locales = locales;
  this.locale = locales.indexOf('zh-cn');
  if (this.locale < 0)
    this.locale = 0;
}
$define(I18nStrings.prototype, {
  getLocalString: function(abbr) {
    if (this.data.hasOwnProperty(abbr))
      return this.data[abbr][this.locale];
    return abbr;
  }
});

function getCountryNames() {
  var names = {};
  fs.readFileSync(path.dirname(module.filename) + '/countries.res')
      .toString()
      .split('\n')
      .forEach(function(line) {
        var match = /([A-Z]+)\s+(.+)/.exec(line);
        if (match)
          names[match[1]] = match[2].split('|');
      });
  return new I18nStrings(names, ['en-us', 'zh-cn']);
}

function initiateTree(TreeNodeType) {

  var countryColls = [{}, {}];
  var prefixColl = [];

  [
    opts.local || 'CN',
    opts.vpn || 'US,GB,JP,HK'
  ].forEach(function(specs, color) {
    specs.split(',').forEach(function(spec) {
      if (/^[A-Z]{2}$/i.test(spec)) {
        countryColls[color][spec.toUpperCase()] = true;
      } else if (/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(spec)) {
        var block = spec.split('/');
        var prefix = new Prefix(block[0], parseInt(block[1], 10));
        prefix.color = color;
        prefixColl.push(prefix);
      }
    });
  });

  var root = new TreeNodeType();
  getAPNICDelegation().forEach(function(prefix) {
    if (countryColls[kRed].hasOwnProperty(prefix.country))
      prefix.color = kRed;
    else if (countryColls[kBlue].hasOwnProperty(prefix.country))
      prefix.color = kBlue;
    root.append(prefix);
  });
  if (!opts.onlyAPNIC)
    getNonAPNICDelegation().forEach(function(prefix) {
      prefix.color = kBlue;
      root.append(prefix);
    });
  prefixColl.forEach(function(prefix) {
    root.append(prefix);
  });

  return root;

}

$define(exports, {
  Prefix: Prefix,
  RouteTable: RouteTable,
  TreeNode: TreeNode,
  toIPv4: toIPv4,
  parseIPv4: parseIPv4,
  getMaskLength: getMaskLength,
  options: opts,
  getAPNICDelegation: getAPNICDelegation,
  getNonAPNICDelegation: getNonAPNICDelegation,
  getCountryNames: getCountryNames,
  initiateTree: initiateTree
});
