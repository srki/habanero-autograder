var http = require("http");
var express = require('express');
var session = require('express-session');
var bodyParser = require('body-parser');
var bcrypt = require('bcrypt-nodejs');
var pg = require('pg');
var multer = require('multer');
var ejs = require('ejs');
var fs = require('fs-extra');
var svn = require('svn-spawn');
var crypto = require('crypto');
var ssh = require('ssh2');
var scp = require('scp2')

var permissionDenied = 'Permission denied. But you should shoot me an e-mail at jmaxg3@gmail.com. If you like playing around with systems, we have interesting research for you in the Habanero group.';

var upload = multer({ dest: 'uploads/' });

var POSTGRES_USERNAME = process.env.PGSQL_USER || 'postgres';
var POSTGRES_PASSWORD = process.env.PGSQL_PASSWORD || 'foobar';
var POSTGRES_USER_TOKEN = null;
if (POSTGRES_PASSWORD.length == 0) {
  POSTGRES_USER_TOKEN = POSTGRES_USERNAME;
} else {
  POSTGRES_USER_TOKEN = POSTGRES_USERNAME + ":" + POSTGRES_PASSWORD;
}

console.log('Connecting to local PGSQL instance with user ' + POSTGRES_USERNAME);

var SVN_USERNAME = process.env.SVN_USER || 'jmg3';
var SVN_PASSWORD = process.env.SVN_PASSWORD || '';
var SVN_REPO = process.env.SVN_REPO ||
    'https://svn.rice.edu/r/parsoft/projects/AutoGrader/student-runs';

console.log('Connecting to SVN repo ' + SVN_REPO + ' as user ' + SVN_USERNAME);

var svn_client = new svn({
        username: SVN_USERNAME,
        password: SVN_PASSWORD
    });

var VIOLA_HOST = process.env.VIOLA_HOST || 'localhost';
var VIOLA_PORT = parseInt(process.env.VIOLA_PORT || '8080');

console.log('Connecting to Viola at ' + VIOLA_HOST + ':' + VIOLA_PORT);

var CLUSTER_HOSTNAME = process.env.CLUSTER_HOSTNAME || 'stic.rice.edu';
var CLUSTER_USER = process.env.CLUSTER_USER || 'jmg3';
var CLUSTER_PASSWORD = process.env.CLUSTER_PASSWORD || '';

console.log('Connecting to remote cluster at ' + CLUSTER_HOSTNAME + ' as ' + CLUSTER_USER);

// TODO load this from JSON file
var conString = "postgres://" + POSTGRES_USER_TOKEN + "@localhost/autograder";

function pgclient(cb) {
  pg.connect(conString, function(err, client, done) {
          if (err) {
            done();
            return console.error('error fetching client from pool', err);
          }
          cb(client, done);
        });
}

function register_query_helpers(query, res, done, username) {
    query.on('row', function(row, result) { result.addRow(row); });
    query.on('error', function(err, result) {
            done();
            res.send(JSON.stringify({ status: 'Failure',
                    msg: 'Internal error (' + err + ')', user: username }));
    });
}

// Assume this is called after 'ready' event is triggered.
function run_ssh(conn, lbl, cmd, cb) {
    conn.exec(cmd, function(err, stream) {
        if (err) {
            conn.end();
            console.log('[' + lbl + '] err=' + err);
            return cb(lbl, null, null, null);
        }
        var acc_stdout = '';
        var acc_stderr = '';
        stream.on('close', function(code, signal) {
            if (code != 0) {
                conn.end();
                console.log('[' + lbl + '] code=' + code + ' signal=' + signal);
                return cb(lbl, null, null, null);
            } else {
                return cb(null, conn, acc_stdout, acc_stderr);
            }
        }).on('data', function(data) {
            acc_stdout = acc_stdout + data;
        }).stderr.on('data', function(data) {
            acc_stderr = acc_stderr + data;
        });
    });
}

var app = express();
app.use(bodyParser.urlencoded());
app.use(session({secret: 'blarp', cookie:{maxAge: 7 * 24 * 3600 * 1000}}));
app.engine('html', ejs.renderFile);
app.set('view engine', 'html');
app.set('views', __dirname + "/views");

/*
 * login/logout routes should always be the only routes above the wildcard '*' route
 */
app.get('/login', function(req, res, next) {
  res.render('login.html');
});

app.post('/login', function(req, res, next) {
  var username = req.body.username;
  var password = req.body.password;

  console.log('login: username=' + username + ' password=' + password);

  // Check that user exists
  pgclient(function(client, done) {
        var query = client.query("SELECT * FROM users WHERE user_name=($1)", [username]);
        register_query_helpers(query, res, done, username);
        query.on('end', function(result) {
              done();
              if (result.rowCount == 0) {
                res.send(JSON.stringify({ status: 'Failure',
                        msg: 'User "' + username + '" does not exist',
                        user: username }));
              } else if (result.rowCount == 1) {
                // Check that password matches
                if (bcrypt.compareSync(password, result.rows[0].password_hash)) {
                  req.session.username = username;
                  req.session.user_id = result.rows[0].user_id;
                  req.session.is_admin = result.rows[0].is_admin;

                  res.send(JSON.stringify({ status: 'Success',
                          redirect: '/overview', user: username }));
                } else {
                  res.send(JSON.stringify({ status: 'Failure',
                          msg: 'Incorrect password for user "' + username + '"',
                          user: username }));
                }
              } else {
                res.send(JSON.stringify({ status: 'Failure',
                        msg: 'Internal error (' + result.rowCount + ')'}));
              }
            });
      });
});

app.get('/logout', function(req, res, next) {
  console.log('logout: username=' + req.session.username);

  req.session.username = null;
  req.session.user_id = null;
  req.session.is_admin = false;

  res.render('login.html');
});

app.get('*', function(req, res, next) {
  if (req.session.username) {
    res.locals.username = req.session.username;
    res.locals.is_admin = req.session.is_admin;

    next();
  } else {
    res.locals.username = null;
    res.locals.is_admin = false;

    res.redirect('/login');
  }
});

app.get('/overview', function(req, res, next) {
  res.render('overview.html');
});

app.get('/admin', function(req, res, next) {
  if (req.session.is_admin) {
    res.render('admin.html');
  } else {
    res.redirect('/overview');
  }
});

function is_actual_svn_err(err) {
  return (err && err.message.trim().search("200 OK") === -1);
}

// Create a new assignment with a given name, not visible to students
var assignment_file_fields = [
                              { name: 'zip', maxCount: 1},
                              { name: 'pom', maxCount: 1}
                             ]
app.post('/assignment', upload.fields(assignment_file_fields), function(req, res, next) {
  console.log('assignment: is_admin=' + req.session.is_admin);
  if (!req.session.is_admin) {
    return res.send(JSON.stringify({ status: 'Failure', msg: permissionDenied }));
  } else {
    var assignment_name = req.body.assignment_name;
    if (assignment_name.length == 0) {
      return res.render('admin.html',
        {err_msg: 'Please provide a non-empty assignment name'});
    }

    if (!req.files.zip) {
      return res.render('admin.html',
        {err_msg: 'Please provide test files for the assignment'});
    }
    if (!req.files.pom) {
      return res.render('admin.html',
        {err_msg: 'Please provide a pom for the assignment'});
    }

    pgclient(function(client, done) {
          var query = client.query(
              "INSERT INTO assignments (name, visible) VALUES ($1,false) RETURNING assignment_id",
              [assignment_name]);
          register_query_helpers(query, res, done, req.session.username);
          query.on('end', function(result) {
              done();
              var assignment_id = result.rows[0].assignment_id;

              var assignment_dir = __dirname + '/instructor-tests/' + assignment_id;

              var dst_dir = SVN_REPO + '/assignments/' + assignment_id;
              var mkdir_msg = 'create assignment ' + assignment_id;
              svn_client.cmd(['mkdir', '--parents', '--message', mkdir_msg, dst_dir],
                function(err, data) {
                  if (is_actual_svn_err(err)) {
                    return res.render('admin.html',
                      {err_msg: 'Error creating assignment directory'});
                  } else {
                    svn_client.cmd(['checkout', dst_dir, assignment_dir], function(err, data) {
                      if (is_actual_svn_err(err)) {
                        return res.render('admin.html',
                          {err_msg: 'Error checking out assignment directory'});
                      } else {
                        fs.renameSync(req.files.zip[0].path, assignment_dir + '/instructor.zip');
                        fs.renameSync(req.files.pom[0].path, assignment_dir + '/pom.xml');
                        svn_client.cmd(['add',
                          assignment_dir + '/instructor.zip',
                          assignment_dir + '/pom.xml'], function(err, data) {
                            if (is_actual_svn_err(err)) {
                              return res.render('admin.html',
                                {err_msg: 'Error adding files to assignment repo'});
                            } else {
                              var commit_msg = 'initial commit for assignment ' + assignment_id;
                              svn_client.cmd(['commit', '--message', commit_msg, assignment_dir],
                                function(err, data) {
                                  if (is_actual_svn_err(err)) {
                                    return res.render('admin.html',
                                      {err_msg: 'Error committing files to assignment repo'});
                                  } else {
                                    return res.redirect('/admin');
                                  }
                                });
                            }
                        });
                      }
                    });
                  }
                });
          });
    });
  }
});

function handle_reupload(req, res, missing_msg, target_filename) {
  if (!req.session.is_admin) {
    return res.send(JSON.stringify({ status: 'Failure', msg: permissionDenied }));
  } else {
    var assignment_id = req.params.assignment_id;

    if (!req.file) {
      return res.render('admin.html', {err_msg: missing_msg});
    }

    pgclient(function(client, done) {
      var query = client.query(
        "SELECT * FROM assignments WHERE assignment_id=($1)", [assignment_id]);
      register_query_helpers(query, res, done, req.session.username);
      query.on('end', function(result) {
        done();
        if (result.rows.length != 1) {
          return res.render('admin.html',
            {err_msg: 'That assignment doesn\'t seem to exist'});
        } else {
          var assignment_dir = __dirname + '/instructor-tests/' + assignment_id;
          fs.renameSync(req.file.path, assignment_dir + '/' + target_filename);
          var commit_msg = 'reupload ' + target_filename + ' for assignment' + assignment_id;
          svn_client.cmd(['commit', '--message', commit_msg, assignment_dir],
            function(err, data) {
              if (is_actual_svn_err(err)) {
                return res.render('admin.html', {err_msg: 'Error updating file in the repo'});
              } else {
                return res.redirect('/admin');
              }
            });
        }
      });
    });
  }
}

app.post('/upload_zip/:assignment_id', upload.single('zip'), function(req, res, next) {
  console.log('upload_zip: is_admin=' + req.session.is_admin);
  return handle_reupload(req, res, 'Please provide a ZIP', 'instructor.zip');
});

app.post('/upload_pom/:assignment_id', upload.single('pom'), function(req, res, next) {
  console.log('upload_zip: is_admin=' + req.session.is_admin);
  return handle_reupload(req, res, 'Please provide a pom.xml', 'pom.xml');
});

/*
 * Get all assignments, with an optional flag to also view not visible
 * assignments (which is only legal for admin users, and ignored for all others).
 */
app.get('/assignments', function(req, res, next) {
  var get_not_visible = false;
  if (req.session.is_admin && req.query.get_not_visible && req.query.get_not_visible === 'true') {
    get_not_visible = true;
  }
  console.log('assignments: username=' + req.session.username +
      ' get_not_visible=' + get_not_visible);

  pgclient(function(client, done) {
    var query = null;
    if (get_not_visible) {
        query = client.query("SELECT * FROM assignments ORDER BY assignment_id ASC");
    } else {
        query = client.query("SELECT * FROM assignments WHERE visible=true;");
    }
    register_query_helpers(query, res, done, req.session.username);
    query.on('end', function(result) {
        done();
        console.log('assignments: returning ' + result.rowCount + ' assignment(s)');
        res.send(JSON.stringify({ status: 'Success',
                'assignments': result.rows }));
    });
  });
});

app.post('/set_assignment_visible', function(req, res, next) {
  console.log('set_assignment_visible: is_admin=' + req.session.is_admin);
  if (!req.session.is_admin) {
    res.send(JSON.stringify({ status: 'Failure', msg: permissionDenied }));
  } else {
    var assignment_id = req.body.assignment_id;
    var set_visible = req.body.set_visible;

    pgclient(function(client, done) {
        var query = client.query(
            "SELECT * FROM assignments WHERE assignment_id=($1);",
            [assignment_id]);
        register_query_helpers(query, res, done, req.session.username);
        query.on('end', function(result) {
            if (result.rowCount == 0) {
                done();
                return res.send(JSON.stringify({ status: 'Failure',
                        msg: 'Invalid assignment ID, does not exist' }));
            } else {
                var query = client.query(
                    "UPDATE assignments SET visible=($1) WHERE assignment_id=($2);",
                    [set_visible, assignment_id]);
                register_query_helpers(query, res, done, req.session.username);
                query.on('end', function(result) {
                    done();
                    return res.send(JSON.stringify({ status: 'Success',
                            redirect: '/admin' }));
                });
            }
        });
    });

  }
});

function get_user_name_for_id(user_id, client, done, res, cb) {
  var query = client.query("SELECT * FROM users WHERE user_id=($1)", [user_id]);
}

function get_user_id_for_name(username, client, done, res, cb) {
  var query = client.query("SELECT * FROM users WHERE user_name=($1)",
      [username]);
  register_query_helpers(query, res, done, username);
  query.on('end', function(result) {
    if (result.rowCount == 0) {
      return cb(0, 'User ' + username + ' does not seem to exist');
    } else if (result.rowCount > 1) {
      return cb(0, 'There appear to be duplicate users ' + username);
    } else {
      // Got the user ID, time to get the assignment ID
      var user_id = result.rows[0].user_id;

      return cb(user_id, null);
    }
  });
}

app.post('/submit_run', upload.single('zip'), function(req, res, next) {
    var assignment_name = req.body.assignment;
    console.log('submit_run: username=' + req.session.username +
      ' assignment="' + assignment_name + '"');

    if (assignment_name.length == 0) {
      return res.render('overview.html', { err_msg: 'Please select an assignment' });
    }

    if (!req.file) {
      return res.render('overview.html', { err_msg: 'Please provide a ZIP file of your assignment' });
    }

    pgclient(function(client, done) {
      get_user_id_for_name(req.session.username, client, done, res,
        function(user_id, err) {
          if (err) {
            done();
            return res.render('overview.html', { err_msg: err });
          }
          var query = client.query("SELECT * FROM assignments WHERE name=($1)",
            [assignment_name]);
          register_query_helpers(query, res, done, req.session.username);
          query.on('end', function(result) {
            if (result.rowCount == 0) {
              done();
              return res.render('overview.html',
                { err_msg: 'Assignment ' + assignment_name + ' does not seem to exist' });
            } else if (result.rowCount > 1) {
              done();
              return res.render('overview.html',
                { err_msg: 'There appear to be duplicate assignments ' + assignment_name });
            } else {
              var assignment_id = result.rows[0].assignment_id;
              crypto.randomBytes(48, function(ex, buf) {
                  var done_token = buf.toString('hex');

                  var query = client.query("INSERT INTO runs (user_id, " +
                      "assignment_id, done_token, status) VALUES " +
                      "($1,$2,$3,'TESTING CORRECTNESS') RETURNING run_id",
                      [user_id, assignment_id, done_token]);
                  register_query_helpers(query, res, done, req.session.username);
                  query.on('end', function(result) {
                    done();
                    var run_id = result.rows[0].run_id;
                    var run_dir = __dirname + '/submissions/' + req.session.username + '/' + run_id;
                    var dst_dir = SVN_REPO + '/' + req.session.username + '/' +
                        assignment_name + '/' + run_id;

                    var mkdir_msg = '"mkdir ' + req.session.username + ' ' + assignment_name + ' ' + run_id + '"';
                    svn_client.cmd(['mkdir', '--parents', '--message', mkdir_msg, dst_dir], function(err, data) {
                      // Special-case an error message from the Habanero repo that we can safely ignore
                      if (is_actual_svn_err(err)) {
                        return res.render('overview.html', { err_msg:
                          'An error occurred backing up your submission' });
                      } else {
                        svn_client.cmd(['checkout', dst_dir, run_dir], function(err, data) {
                          if (is_actual_svn_err(err)) {
                            return res.render('overview.html', { err_msg:
                              'An error occurred backing up your submission' });
                          } else {
                            // Move submitted file into newly created local SVN working copy
                            fs.renameSync(req.file.path, run_dir + '/' + req.file.originalname);
                            svn_client.cmd(['add', run_dir + '/' + req.file.originalname], function(err, data) {
                              if (is_actual_svn_err(err)) {
                                return res.render('overview.html', { err_msg:
                                  'An error occurred backing up your submission' });
                              } else {
                                var commit_msg = '"add ' + req.session.username + ' ' + assignment_name + ' ' + run_id + '"';
                                svn_client.cmd(['commit', '--message', commit_msg, run_dir], function(err, data) {
                                  if (is_actual_svn_err(err)) {
                                    return res.render('overview.html', { err_msg:
                                      'An error occurred backing up your submission' });
                                  } else {
                                    var viola_params = 'done_token=' + done_token +
                                        '&user=' + req.session.username +
                                        '&assignment=' + assignment_name + '&run=' +
                                        run_id + '&assignment_id=' + assignment_id;
                                    var viola_options = { host: VIOLA_HOST,
                                        port: VIOLA_PORT, path: '/run?' + viola_params };
                                    http.get(viola_options, function(viola_res) {
                                        var bodyChunks = [];
                                        viola_res.on('data', function(chunk) {
                                            bodyChunks.push(chunk);
                                        }).on('end', function() {
                                            var body = Buffer.concat(bodyChunks);
                                            var result = JSON.parse(body);
                                            if (result.status === 'Success') {
                                                return res.redirect('/overview');
                                            } else {
                                                return res.render('overview.html',
                                                    { err_msg: 'Viola error: ' + result.msg });
                                            }
                                        });
                                    }).on('error', function(err) {
                                        console.log('VIOLA err="' + err + '"');
                                        return res.render('overview.html',
                                            { err_msg: 'An error occurred launching the local tests' });
                                    });
                                  }
                                });
                              }
                            });
                          }
                        });
                      }
                    });
                  });
              });
            }
          });
        });
    });
});

app.post('/local_run_finished', function(req, res, next) {
    var done_token = req.body.done_token;
    console.log('local_run_finished: done_token=' + done_token);

    pgclient(function(client, done) {
        // Can only be one match here because of SQL schema constraints
        var query = client.query("SELECT * FROM runs WHERE done_token=($1)", [done_token]);
        register_query_helpers(query, res, done, 'unknown');
        query.on('end', function(result) {
          if (result.rows.length != 1) {
            done();
            return res.send(JSON.stringify({status: 'Failure',
                msg: 'Unexpected # of rows, ' + result.rows.length}));
          } else {
            var run_id = result.rows[0].run_id;
            var user_id = result.rows[0].user_id;

            var query = client.query("SELECT * FROM users WHERE user_id=($1)", [user_id]);
            register_query_helpers(query, res, done, 'unknown');
            query.on('end', function(result) {
              if (result.rows.length != 1) {
                done();
                return res.send(JSON.stringify({status: 'Failure', msg: 'Invalid user ID'}));
              } else {
                var username = result.rows[0].user_name;
                var run_dir = __dirname + '/submissions/' + username + '/' + run_id;

                var query = client.query(
                    "UPDATE runs SET status='TESTING PERFORMANCE' WHERE run_id=($1)", [run_id]);
                register_query_helpers(query, res, done, req.session.username);
                query.on('end', function(result) {
                    done();

                    svn_client.cmd(['up', '--accept', 'theirs-full', run_dir], function(err, data) {
                      if (err) {
                        return res.send(JSON.stringify({status: 'Failure',
                          msg: 'Failed updating repo, ' + err}));
                      } else {

                        fs.appendFileSync(run_dir + '/bass.slurm', "#!/bin/bash\n");
                        fs.appendFileSync(run_dir + '/bass.slurm', "\n");
                        fs.appendFileSync(run_dir + '/bass.slurm', "#SBATCH --job-name=habanero-autograder-" + run_id + "\n");
                        fs.appendFileSync(run_dir + '/bass.slurm', "#SBATCH --cpus-per-task=8\n");
                        fs.appendFileSync(run_dir + '/bass.slurm', "#SBATCH --exclusive\n");
                        fs.appendFileSync(run_dir + '/bass.slurm', "#SBATCH --nodes=1\n");
                        fs.appendFileSync(run_dir + '/bass.slurm', "#SBATCH --time=00:10:00\n");
                        fs.appendFileSync(run_dir + '/bass.slurm', "#SBATCH --partition=interactive\n");
                        fs.appendFileSync(run_dir + '/bass.slurm', "#SBATCH --output=/home/" + CLUSTER_USER + "/autograder/" + run_id + "/stdout.txt\n");
                        fs.appendFileSync(run_dir + '/bass.slurm', "#SBATCH --error=/home/" + CLUSTER_USER + "/autograder/" + run_id + "/stderr.txt\n");
                        fs.appendFileSync(run_dir + '/bass.slurm', "\n");
                        fs.appendFileSync(run_dir + '/bass.slurm', "echo Job $SLURM_JOBID\n");

                        // Launch on the cluster
                        var conn = new ssh.Client();
                        var MKDIR_CMD = 'mkdir -p ~/autograder/' + run_id;
                        var SCP_DST = CLUSTER_USER + ':' + CLUSTER_PASSWORD +
                            '@' + CLUSTER_HOSTNAME + ':autograder/' + run_id + '/bass.slurm';
                        console.log('local_run_finished: Connecting to ' +
                            CLUSTER_USER + '@' + CLUSTER_HOSTNAME);
                        conn.on('ready', function() {
                            run_ssh(conn, 'creating autograder dir', MKDIR_CMD,
                                function(err, conn, stdout, stderr) {
                                     if (err) {
                                       return res.send(JSON.stringify({status: 'Failure',
                                         msg: 'Failed creating autograder dir'}));
                                     }
                                     scp.scp(run_dir + '/bass.slurm', SCP_DST, function(err) {
                                        if (err) {
                                            console.log('scp err=' + err);
                                            return res.send(JSON.stringify({status: 'Failure',
                                                    msg: 'Failed scp-ing bass.slurm'}));
                                        }
                                        run_ssh(conn, 'sbatch',
                                            'sbatch ~/autograder/' + run_id + '/bass.slurm',
                                            function(err, conn, stdout, stderr) {
                                                if (err) {
                                                  return res.send(JSON.stringify({status: 'Failure',
                                                    msg: 'Failed submitting job'}));
                                                }
                                                conn.end();
                                                // stdout == Submitted batch job 474297
                                                if (stdout.search('Submitted batch job ') !== 0) {
                                                    return res.send(
                                                        JSON.stringify({
                                                            status: 'Failure',
                                                            msg: 'Failed submitting batch job'}));
                                                }
                                                var tokens = stdout.trim().split(' ');
                                                var job_id = tokens[tokens.length - 1];
                                                pgclient(function(client, done) {
                                                    var query = client.query('UPDATE runs SET job_id=($1) WHERE run_id=($2)', [job_id, run_id]);
                                                    register_query_helpers(query, res, done, req.session.username);
                                                    query.on('end', function(result) {
                                                        done();
                                                        return res.send(
                                                            JSON.stringify({ status: 'Success' }));
                                                    });
                                                });
                                            });
                                     });
                                });
                        }).connect({
                            host: CLUSTER_HOSTNAME,
                            port: 22,
                            username: CLUSTER_USER,
                            password: CLUSTER_PASSWORD
                        });
                      }
                    });
                });
              }
            });
          }
        });
    });
});

app.get('/runs', function(req, res, next) {
  pgclient(function(client, done) {
    get_user_id_for_name(req.session.username, client, done, res,
      function(user_id, err) {
        if (err) {
          done();
          return res.send(JSON.stringify({ status: 'Failure', msg: err }));
        } else {
          var query = client.query(
              "SELECT * FROM runs WHERE user_id=($1) ORDER BY run_id DESC",
              [user_id]);
          register_query_helpers(query, res, done, req.session.username);
          query.on('end', function(result) {
            var runs = result.rows;

            var query = client.query("SELECT * FROM assignments");
            register_query_helpers(query, res, done, req.session.username);
            query.on('end', function(result) {
                done();
                var assignment_mapping = {};
                for (var i = 0; i < result.rows.length; i++) {
                    assignment_mapping[result.rows[i].assignment_id] = result.rows[i].name;
                }
                var translated_runs = [];
                for (var i = 0; i < runs.length; i++) {
                    var name = assignment_mapping[runs[i].assignment_id];
                    translated_runs.push({run_id: runs[i].run_id,
                                          assignment_name: name,
                                          status: runs[i].status });
                }
                return res.send(JSON.stringify({ status: 'Success', runs: translated_runs }));
            });
          });
        }
      });
  });
});

app.get('/run/:run_id', function(req, res, next) {
    var run_id = req.params.run_id;
    pgclient(function(client, done) {
        var query = client.query("SELECT user_id FROM runs WHERE run_id=($1)",
            [run_id]);
        register_query_helpers(query, res, done, req.session.username);
        query.on('end', function(result) {
            done();
            if (result.rows.length == 0) {
                return res.render('overview.html', { err_msg: 'Unknown run' });
            } else {
                var user_id = result.rows[0].user_id;
                if (user_id != req.session.user_id) {
                    return res.send(401);
                } else {
                    var run_dir = __dirname + '/submissions/' +
                        req.session.username + '/' + run_id;
                    var log_files = {};
                    fs.readdirSync(run_dir).forEach(function(file) {
                      if (file.indexOf('.txt', file.length - '.txt'.length) !== -1) {
                          log_files[file] = fs.readFileSync(run_dir + '/' + file);
                      }
                    });

                    return res.render('run.html', { run_id: run_id, log_files: log_files });
                }
            }
        });
    });
});

app.get('/', function(req, res, next) {
  return res.redirect('overview');
});

function check_cluster_helper(perf_runs, i, conn, client, done) {
    if (i >= perf_runs.length) {
        done();
        conn.end();
        setTimeout(check_cluster, 30000);
    } else {
        var run = perf_runs[i];
        console.log('check_cluster_helper: ' + JSON.stringify(run));
        var SACCT = "sacct --noheader -j " + run.job_id + " -u jmg3 " +
            "--format=JobName,State | grep hab | awk '{ print $2 }'";
        run_ssh(conn, 'checking job status', SACCT, function(err, conn, stdout, stderr) {
            if (err) {
              done();
              conn.end();
              setTimeout(check_cluster, 30000);
              return;
            }
            stdout = stdout.trim();
            var query = null;
            if (stdout === 'FAILED') {
                console.log('check_cluster_helper: marking ' + run.run_id + ' FAILED');
                query = client.query(
                    "UPDATE runs SET status='FAILED' WHERE run_id=($1)",
                    [run.run_id]);
            } else if (stdout === 'COMPLETED') {
                console.log('check_cluster_helper: marking ' + run.run_id + ' FINISHED');
                query = client.query(
                    "UPDATE runs SET status='FINISHED' WHERE run_id=($1)",
                    [run.run_id]);
            }

            if (query) {
                query.on('row', function(row, result) { result.addRow(row); });
                query.on('error', function(err, result) {
                        console.log('Error updating running perf tests: ' + err);
                        done();
                        conn.end();
                        setTimeout(check_cluster, 30000);
                });
                query.on('end', function(result) {
                  var query = client.query(
                    'SELECT * FROM users WHERE user_id=($1)', [run.user_id]);
                  query.on('row', function(row, result) { result.addRow(row); });
                  query.on('error', function(err, result) {
                          console.log('Error finding user name: ' + err);
                          done();
                          conn.end();
                          setTimeout(check_cluster, 30000);
                  });
                  query.on('end', function(result) {
                    if (result.rows.length != 1) {
                      console.log('Missing user, user_id=' + run.user_id);
                      done();
                      conn.end();
                      setTimeout(check_cluster, 30000);
                    } else {
                      var username = result.rows[0].user_name;
                      var REMOTE_FOLDER = CLUSTER_USER + ':' + CLUSTER_PASSWORD +
                          '@' + CLUSTER_HOSTNAME + ':autograder/' + run.run_id;
                      var REMOTE_STDOUT = REMOTE_FOLDER + '/stdout.txt';
                      var REMOTE_STDERR = REMOTE_FOLDER + '/stderr.txt';
                      var LOCAL_FOLDER = __dirname + '/submissions/' +
                        username + '/' + run.run_id;
                      var LOCAL_STDOUT = LOCAL_FOLDER + '/cluster-stdout.txt';
                      var LOCAL_STDERR = LOCAL_FOLDER + '/cluster-stderr.txt';
                      var LOCAL_SLURM = LOCAL_FOLDER + '/bass.slurm';

                      scp.scp(REMOTE_STDOUT, LOCAL_STDOUT, function(err) {
                        if (err) {
                          console.log('scp err=' + err);
                          done();
                          conn.end();
                          setTimeout(check_cluster, 30000);
                        } else {
                          scp.scp(REMOTE_STDERR, LOCAL_STDERR, function(err) {
                            if (err) {
                              console.log('scp err=' + err);
                              done();
                              conn.end();
                              setTimeout(check_cluster, 30000);
                            } else {
                              run_ssh(conn, 'cleaning up job dir',
                                'rm -r autograder/' + run.run_id,
                                function(err, conn, stdout, stderr) {
                                  if (err) {
                                    done();
                                    conn.end();
                                    setTimeout(check_cluster, 30000);
                                  } else {
                                    svn_client.cmd(
                                      ['add', LOCAL_STDOUT, LOCAL_STDERR, LOCAL_SLURM],
                                      function(err, data) {
                                        if (err) {
                                          console.log('Error adding local files: ' + err);
                                          done();
                                          conn.end();
                                          setTimeout(check_cluster, 30000);
                                        } else {
                                          svn_client.cmd(['commit', '--message', 'add local files', LOCAL_FOLDER], function(err, data) {
                                            if (err) {
                                              console.log('Error committing local files: ' + err);
                                              done();
                                              conn.end();
                                              setTimeout(check_cluster, 30000);
                                            } else {
                                              check_cluster_helper(perf_runs, i + 1, conn, client, done);
                                            }
                                          });
                                        }
                                      });
                                  }
                                });
                            }
                          });
                        }
                      });
                    }
                  });

                });
            } else {
                check_cluster_helper(perf_runs, i + 1, conn, client, done);
            }
        })
                
    }
}

// Cluster functionality
function check_cluster() {
    console.log('check_cluster fired');

    pgclient(function(client, done) {
        var query = client.query("SELECT * FROM runs WHERE status='TESTING PERFORMANCE'");
        query.on('row', function(row, result) { result.addRow(row); });
        query.on('error', function(err, result) {
                done();
                console.log('Error looking up running perf tests: ' + err);
                setTimeout(check_cluster, 30000);
        });
        query.on('end', function(result) {

            var perf_runs = result.rows;
            var conn = new ssh.Client();
            conn.on('ready', function() {
                check_cluster_helper(perf_runs, 0, conn, client, done);
            }).connect({
                host: CLUSTER_HOSTNAME,
                port: 22,
                username: CLUSTER_USER,
                password: CLUSTER_PASSWORD
            });
        });
    });
}

setTimeout(check_cluster, 0);

var port = process.env.PORT || 8000

var oneDay = 86400000;
app.use(express.static(__dirname + '/views', { maxAge: oneDay }));

var server = app.listen(port, function() {
  console.log('Server listening at http://%s:%s', 
    server.address().address,
    server.address().port);
})
