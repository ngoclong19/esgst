import JSZip from 'jszip';

let browserInfo = null;
let hasAddedWebRequestListener = false;

if (browser.webRequest) {
	addWebRequestListener();
}

// getBrowserInfo must be removed from webextension-polyfill/browser-polyfill.min.js for this to work on Chrome
if ('getBrowserInfo' in browser.runtime) {
	browser.runtime.getBrowserInfo().then((result) => (browserInfo = result));
} else {
	browserInfo = { name: '?' };
}

browser.storage.local.get('settings').then(async (result) => {
	/**
	 * @type {object}
	 * @property {boolean} activateTab_sg
	 * @property {boolean} activateTab_st
	 */
	const settings = result.settings ? JSON.parse(result.settings) : {};
	if (settings.activateTab_sg || settings.activateTab_st) {
		// Get the currently active tab.
		const currentTab = (await queryTabs({ active: true }))[0];
		if (settings.activateTab_sg) {
			// Set the SG tab as active.
			await activateTab('steamgifts');
		}
		if (settings.activateTab_st) {
			// Set the ST tab as active.
			await activateTab('steamtrades');
		}
		// Go back to the previously active tab.
		if (currentTab && currentTab.id) {
			await updateTab(currentTab.id, { active: true });
		}
	}
	if (settings.notifyNewVersion_sg || settings.notifyNewVersion_st) {
		const url = [];
		if (settings.notifyNewVersion_sg) {
			url.push(`*://*.steamgifts.com/*`);
		}
		if (settings.notifyNewVersion_st) {
			url.push(`*://*.steamtrades.com/*`);
		}
		browser.runtime.onUpdateAvailable.addListener((details) => {
			browser.tabs.query({ url }).then((tabs) => {
				const tab = tabs[0];
				if (tab) {
					browser.tabs
						.sendMessage(
							tab.id,
							JSON.stringify({
								action: 'update',
								values: details,
							})
						)
						.then(() => {});
				} else {
					browser.runtime.reload();
				}
			});
		});
	}
});

function addWebRequestListener() {
	hasAddedWebRequestListener = true;

	const webRequestFilters = {
		types: ['xmlhttprequest'],
		urls: [
			'*://*.steamgifts.com/*',
			'*://*.steamtrades.com/*',
			'*://*.sgtools.info/*',
			'*://*.steamcommunity.com/*',
			'*://*.store.steampowered.com/*',
		],
	};

	browser.webRequest.onBeforeSendHeaders.addListener(
		(details) => {
			const esgstCookie = details.requestHeaders.filter(
				(header) => header.name.toLowerCase() === 'esgst-cookie'
			)[0];

			if (esgstCookie) {
				esgstCookie.name = 'Cookie';

				return {
					requestHeaders: details.requestHeaders,
				};
			}
		},
		webRequestFilters,
		['blocking', 'requestHeaders']
	);
}

async function sendMessage(action, sender, values, sendToAll) {
	const tabs = await browser.tabs.query({
		url: [`*://*.steamgifts.com/*`, `*://*.steamtrades.com/*`],
	});
	for (const tab of tabs) {
		if (sender && tab.id === sender.tab.id) {
			continue;
		}
		await browser.tabs.sendMessage(
			tab.id,
			JSON.stringify({
				action: action,
				values: values,
			})
		);
		if (!sender && !sendToAll) {
			return;
		}
	}
}

async function getZip(data, fileName) {
	const zip = new JSZip();
	zip.file(fileName, data);
	return await zip.generateAsync({
		compression: 'DEFLATE',
		compressionOptions: {
			level: 9,
		},
		type: 'blob',
	});
}

async function readZip(data) {
	const zip = new JSZip(),
		/** @property {Object} files */
		contents = await zip.loadAsync(data),
		keys = Object.keys(contents.files),
		output = [];
	for (const key of keys) {
		output.push({
			name: key,
			value: await zip.file(key).async('text'),
		});
	}
	return output;
}

async function doFetch(parameters, request, sender, callback) {
	if (request.fileName) {
		parameters.body = await getZip(parameters.body, request.fileName);
	}

	if (
		request.manipulateCookies &&
		(await browser.permissions.contains({ permissions: ['cookies'] }))
	) {
		let esgstCookie = parameters.headers.get('Esgst-Cookie') || '';

		const domain = request.url.match(/https?:\/\/(.+?)(\/.*)?$/)[1];

		const tab = await browser.tabs.get(sender.tab.id);

		const cookies = await browser.cookies.getAll({
			domain,
			storeId: tab.cookieStoreId,
			firstPartyDomain: null,
		});

		for (const cookie of cookies) {
			esgstCookie += `${cookie.name}=${cookie.value}; `;
		}

		parameters.headers.append('Esgst-Cookie', esgstCookie);
	}

	let response = null;
	let responseText = null;
	try {
		response = await window.fetch(request.url, parameters);
		responseText = request.blob
			? (await readZip(await response.blob()))[0].value
			: await response.text();
		if (!response.ok) {
			throw responseText;
		}
	} catch (error) {
		callback(JSON.stringify({ error }));
		return;
	}
	callback(
		JSON.stringify({
			finalUrl: response.url,
			redirected: response.redirected,
			responseText: responseText,
		})
	);
}

const locks = {};

function do_lock(lock) {
	return new Promise((resolve) => {
		_do_lock(lock, resolve);
	});
}

function _do_lock(lock, resolve) {
	const now = Date.now();
	let locked = locks[lock.key];
	if (
		!locked ||
		!locked.uuid ||
		locked.timestamp < now - (lock.threshold + (lock.timeout || 15000))
	) {
		locks[lock.key] = {
			timestamp: now,
			uuid: lock.uuid,
		};
		setTimeout(() => {
			locked = locks[lock.key];
			if (!locked || locked.uuid !== lock.uuid) {
				if (!lock.lockOrDie) {
					setTimeout(() => _do_lock(lock, resolve), 0);
				} else {
					resolve('false');
				}
			} else {
				resolve('true');
			}
		}, lock.threshold / 2);
	} else if (!lock.lockOrDie) {
		setTimeout(() => _do_lock(lock, resolve), lock.threshold / 3);
	} else {
		resolve('false');
	}
}

function update_lock(lock) {
	const locked = locks[lock.key];
	if (locked.uuid === lock.uuid) {
		locked.timestamp = Date.now();
	}
}

function do_unlock(lock) {
	if (locks[lock.key] && locks[lock.key].uuid === lock.uuid) {
		delete locks[lock.key];
	}
}

let tdsData = [];

browser.runtime.onMessage.addListener((request, sender) => {
	return new Promise(async (resolve) => {
		let parameters;
		switch (request.action) {
			case 'get-tds':
				resolve(JSON.stringify(tdsData));

				break;
			case 'notify-tds':
				tdsData = JSON.parse(request.data);

				sendMessage('notify-tds', null, tdsData, true);

				resolve();

				break;
			case 'permissions_contains':
				resolve(await browser.permissions.contains(JSON.parse(request.permissions)));
				break;
			case 'getBrowserInfo':
				resolve(JSON.stringify(browserInfo));
				break;
			case 'do_lock':
				do_lock(JSON.parse(request.lock)).then(resolve);
				break;
			case 'update_lock':
				update_lock(JSON.parse(request.lock));
				resolve();
				break;
			case 'do_unlock':
				do_unlock(JSON.parse(request.lock));
				resolve();
				break;
			case 'fetch':
				if (!hasAddedWebRequestListener && browser.webRequest) {
					addWebRequestListener();
				}

				parameters = JSON.parse(request.parameters);
				parameters.headers = new Headers(parameters.headers);
				// noinspection JSIgnoredPromiseFromCall
				doFetch(parameters, request, sender, resolve);
				break;
			case 'reload':
				browser.runtime.reload();
				resolve();
				break;
			case 'tabs':
				// noinspection JSIgnoredPromiseFromCall
				getTabs(request);
				break;
			case 'open_tab':
				openTab(request.url);
				break;
		}
	});
});

async function getTabs(request) {
	let items = [
		{
			id: 'inbox_sg',
			pattern: `*://*.steamgifts.com/messages*`,
			url: `https://www.steamgifts.com/messages`,
		},
		{
			id: 'inbox_st',
			pattern: `*://*.steamtrades.com/messages*`,
			url: `https://www.steamtrades.com/messages`,
		},
		{
			id: 'wishlist',
			pattern: `*://*.steamgifts.com/giveaways/search?*type=wishlist*`,
			url: `https://www.steamgifts.com/giveaways/search?type=wishlist`,
		},
		{
			id: 'won',
			pattern: `*://*.steamgifts.com/giveaways/won*`,
			url: `https://www.steamgifts.com/giveaways/won`,
		},
	];
	let any = false;
	for (let i = 0, n = items.length; i < n; i++) {
		let item = items[i];
		if (!request[item.id]) {
			continue;
		}
		let tab = (await queryTabs({ url: item.pattern }))[0];
		if (tab && tab.id) {
			await updateTab(tab.id, { active: true });
			if (request.refresh) {
				browser.tabs.reload(tab.id);
			}
		} else if (request.any) {
			any = true;
		} else {
			openTab(item.url);
		}
	}
	if (any) {
		let tab = (await queryTabs({ url: `*://*.steamgifts.com/*` }))[0];
		if (tab && tab.id) {
			await updateTab(tab.id, { active: true });
		}
	}
}

async function openTab(url) {
	const options = { url };
	const tab = (await browser.tabs.query({ active: true }))[0];
	if (tab) {
		options.index = tab.index + 1;
		if (tab.cookieStoreId) {
			options.cookieStoreId = tab.cookieStoreId;
		}
	}
	return browser.tabs.create(options);
}

function queryTabs(query) {
	return browser.tabs.query(query);
}

function updateTab(id, parameters) {
	return browser.tabs.update(id, parameters);
}

async function activateTab(host) {
	const tab = (await queryTabs({ url: `*://*.${host}.com/*` }))[0];
	if (tab && tab.id) {
		await updateTab(tab.id, { active: true });
	}
}
